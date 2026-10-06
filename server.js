const express=require("express");
const multer=require("multer");
const fs=require("fs");
const path=require("path");
const crypto=require("crypto");
const {GoogleGenerativeAI}=require("@google/generative-ai");
const ffmpeg=require("ffmpeg-static");
const ffprobe=require("ffprobe-static");
const {execFile}=require("child_process");

const app=express();
const PORT=process.env.PORT||10000;
const ROOT=__dirname;
const UP=path.join(ROOT,"uploads");
const OUT=path.join(ROOT,"outputs");
fs.mkdirSync(UP,{recursive:true}); fs.mkdirSync(OUT,{recursive:true});

const upload=multer({dest:UP,limits:{fileSize:(Number(process.env.MAX_FILE_MB)||500)*1024*1024}});
app.use(express.json({limit:"2mb"}));
app.use(express.static(path.join(ROOT,"public")));

const jobs=new Map();
const run=(bin,args)=>new Promise((resolve,reject)=>execFile(bin,args,{maxBuffer:40*1024*1024},(e,stdout,stderr)=>e?reject(new Error(stderr||e.message)):resolve(stdout)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function getKey(req){return req.headers["x-gemini-api-key"]||process.env.GEMINI_API_KEY}
function job(id,p){jobs.set(id,{...(jobs.get(id)||{}),...p,updatedAt:Date.now()})}
function srtTime(sec){const ms=Math.max(0,Math.round(sec*1000)),h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000),x=ms%1000;return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0")+","+String(x).padStart(3,"0")}
function cleanSrt(t){t=String(t||"").replace(/^```(?:srt|text)?/i,"").replace(/```$/,"").trim();const m=t.match(/(?:^|\n)\d+\s*\n\d\d:\d\d:\d\d,\d{3}\s*-->\s*\d\d:\d\d:\d\d,\d{3}[\s\S]*/);return(m?m[0]:t).trim()}
function parseSrt(srt){return srt.split(/\n\s*\n/).map(b=>{const l=b.split(/\r?\n/),i=l.findIndex(x=>x.includes("-->"));if(i<0)return null;const m=l[i].match(/(\d\d:\d\d:\d\d,\d{3})\s*-->\s*(\d\d:\d\d:\d\d,\d{3})/);return m?{start:m[1],end:m[2],text:l.slice(i+1).join(" ").trim()}:null}).filter(Boolean)}
async function gemini(prompt,key,audioBase64){
  const gen=new GoogleGenerativeAI(key);
  const model=gen.getGenerativeModel({model:process.env.GEMINI_MODEL||"gemini-2.5-flash"});
  const parts=audioBase64?[{inlineData:{data:audioBase64,mimeType:"audio/wav"}},{text:prompt}]:prompt;
  let last;
  for(let i=0;i<3;i++){try{return (await model.generateContent(parts)).response.text()}catch(e){last=e;if(!/503|UNAVAILABLE|overloaded|high demand|429/i.test(String(e.message||e)))throw e;await sleep(1500*(i+1))}}
  throw last||new Error("Gemini temporarily unavailable");
}
async function tts(text,file){
  const {ttsSave}=require("edge-tts");
  await ttsSave(text,file,{voice:process.env.TTS_VOICE||"my-MM-ThihaNeural",rate:process.env.TTS_RATE||"-5%",volume:"+0%",pitch:"+0Hz"});
}
async function processJob(id,input,opts){
  const dir=path.join(OUT,id);fs.mkdirSync(dir,{recursive:true});
  const audio=path.join(dir,"audio.wav"), voice=path.join(dir,"voice.mp3");
  try{
    job(id,{status:"processing",stage:"audio",progress:12});
    // Check whether the uploaded video actually contains an audio stream.
    // Some downloaded MP4/DASH videos are video-only; the old "0:a:0"
    // mapping caused FFmpeg to abort with "matches no streams".
    const audioStreams=await run(ffprobe.path,[
      "-v","error","-select_streams","a","-show_entries","stream=index",
      "-of","csv=p=0",input
    ]);
    if(!audioStreams.trim()){
      throw new Error("ဒီ Video ဖိုင်မှာ Audio Track မပါပါ။ အသံပါဝင်တဲ့ MP4 ကို ပြန်တင်ပေးပါ။");
    }
    await run(ffmpeg,["-y","-i",input,"-map","0:a:0","-ac","1","-ar","16000","-c:a","pcm_s16le",audio]);
    job(id,{stage:"transcription",progress:30});
    const key=opts.key;
    const b64=fs.readFileSync(audio).toString("base64");
    const original=cleanSrt(await gemini("Create an accurate ORIGINAL-language subtitle transcript from this audio. Return ONLY valid SRT. Use sequential cue numbers and HH:MM:SS,mmm timestamps. Do not translate or explain.",key,b64));
    fs.writeFileSync(path.join(dir,"original.srt"),original);
    job(id,{stage:"translation",progress:48});
    const burmese=cleanSrt(await gemini("Translate every subtitle line below into natural conversational Burmese. Keep ALL cue numbers and timestamps EXACTLY unchanged. Return ONLY valid SRT. Do not add/remove cues.\n\n"+original,key));
    fs.writeFileSync(path.join(dir,"burmese.srt"),burmese);
    job(id,{stage:"recap",progress:64});
    const recap=await gemini("Write a natural, engaging Burmese movie recap narration from these Burmese subtitles. Keep the story accurate, explain events clearly, use casual spoken Burmese suitable for AI voice, and do not invent major events. Output ONLY the narration.\n\n"+burmese,key);
    fs.writeFileSync(path.join(dir,"recap.txt"),recap.trim());
    job(id,{stage:"voice",progress:78});
    await tts(recap.trim(),voice);
    job(id,{stage:"render",progress:88});
    const ratio=opts.ratio||"9:16",crf=String(opts.crf||28);
    const vf=ratio==="16:9"?"scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2":ratio==="1:1"?"scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2":"scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2";
    const final=path.join(dir,"final.mp4");
    const dur=Number((await run(ffprobe.path,["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",input])).trim())||0;
    await run(ffmpeg,["-y","-i",input,"-i",voice,"-vf",vf,"-map","0:v:0","-map","1:a:0","-t",String(dur),"-c:v","libx264","-preset","veryfast","-crf",crf,"-c:a","aac","-b:a","128k","-movflags","+faststart",final]);
    job(id,{status:"complete",stage:"complete",progress:100,files:{video:"/api/download/"+id+"/final.mp4",originalSrt:"/api/download/"+id+"/original.srt",burmeseSrt:"/api/download/"+id+"/burmese.srt",recap:"/api/download/"+id+"/recap.txt"}});
  }catch(e){job(id,{status:"error",stage:"error",progress:0,error:e.message})}
  finally{try{fs.unlinkSync(input)}catch{}}
}

app.get("/api/health",(req,res)=>res.json({ok:true,app:"Lynn Movie Recap",version:"2.0.0"}));
app.post("/api/process",upload.single("video"),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:"Video မရှိပါ"});
  const key=getKey(req);if(!key)return res.status(400).json({error:"Gemini API Key ထည့်ပါ"});
  const id=crypto.randomUUID();
  job(id,{status:"queued",stage:"queued",progress:3});
  processJob(id,req.file.path,{key,ratio:req.body.ratio,crf:req.body.crf});
  res.json({jobId:id});
});
app.get("/api/status/:id",(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});res.json(j)});
app.get("/api/download/:id/:file",(req,res)=>{const allowed=["final.mp4","original.srt","burmese.srt","recap.txt"];const file=path.basename(req.params.file);if(!allowed.includes(file))return res.status(400).send("Invalid file");const p=path.join(OUT,req.params.id,file);if(!fs.existsSync(p))return res.status(404).send("File not found");res.download(p,file)});
app.listen(PORT,()=>console.log("Lynn Movie Recap 2.0 running on "+PORT));