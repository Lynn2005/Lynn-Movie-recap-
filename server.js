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
  // Gemini is no longer used for automatic transcription/translation.
  // Keep this helper only for future recap features.
  const gen=new GoogleGenerativeAI(key);
  const configuredModel=process.env.GEMINI_MODEL||"gemini-3.8-flash";
  const modelName=configuredModel==="gemini-2.5-flash"?"gemini-3.8-flash":configuredModel;
  const model=gen.getGenerativeModel({model:modelName});
  const parts=audioBase64?[{inlineData:{data:audioBase64,mimeType:"audio/wav"}},{text:prompt}]:prompt;
  let last;
  for(let i=0;i<3;i++){try{return (await model.generateContent(parts)).response.text()}catch(e){last=e;if(!/503|UNAVAILABLE|overloaded|high demand|429/i.test(String(e.message||e)))throw e;await sleep(1500*(i+1))}}
  throw last||new Error("Gemini temporarily unavailable");
}
async function tts(text,file){
  const {ttsSave}=require("edge-tts");
  await ttsSave(text,file,{voice:process.env.TTS_VOICE||"my-MM-ThihaNeural",rate:process.env.TTS_RATE||"-5%",volume:"+0%",pitch:"+0Hz"});
}
async function probeAudioStream(input){
  // Probe all streams instead of relying only on -select_streams.
  // This is more tolerant of phone-recorded/container files.
  try{
    const out=await run(ffprobe.path,[
      "-v","error",
      "-show_streams",
      "-of","json",
      input
    ]);
    const data=JSON.parse(out||"{}");
    return (data.streams||[]).find(x=>x.codec_type==="audio")||null;
  }catch(e){
    return null;
  }
}

async function extractAudio(input,audio,browserAudio){
  try{if(fs.existsSync(audio))fs.unlinkSync(audio)}catch{}

  // First try extracting directly from the original video.
  try{
    await run(ffmpeg,[
      "-y","-nostdin","-hide_banner","-loglevel","error",
      "-i",input,
      "-map","0:a:0",
      "-vn",
      "-ac","1",
      "-ar","16000",
      "-c:a","pcm_s16le",
      "-f","wav",
      audio
    ]);
    if(fs.existsSync(audio)&&fs.statSync(audio).size>=2048) return "ffmpeg";
  }catch(e){
    // Some phone/browser uploads can play audio in Chrome while the server-side
    // container probe cannot expose an audio stream. Fall back to browser audio.
  }

  // Browser fallback: the client sends a real audio track captured/decoded
  // from the uploaded video.
  if(browserAudio && fs.existsSync(browserAudio)){
    try{
      await run(ffmpeg,[
        "-y","-nostdin","-hide_banner","-loglevel","error",
        "-i",browserAudio,
        "-vn",
        "-ac","1",
        "-ar","16000",
        "-c:a","pcm_s16le",
        "-f","wav",
        audio
      ]);
      if(fs.existsSync(audio)&&fs.statSync(audio).size>=2048) return "browser";
    }catch(e){
      const msg=String(e.message||e);
      throw new Error("Video Audio ကို Server က တိုက်ရိုက်မဖတ်နိုင်လို့ Browser Audio Backup ကို သုံးရာမှာလည်း မအောင်မြင်ပါ။\n"+msg.split("\n").slice(-8).join("\n"));
    }
  }

  throw new Error("Upload လုပ်ထားတဲ့ Video ရဲ့ Audio ကို Server က မဖတ်နိုင်ပါ။ CREATE RECAP နှိပ်တဲ့အခါ Browser Audio Backup ကို အရင်ပြင်ဆင်ပေးထားပါတယ် — မရသေးရင် Chrome မှာ Video ကို တစ်ခါ Play လုပ်ပြီး ပြန်စမ်းပါ။");
}

async function processJob(id,input,opts){
  let failedStage="audio";
  const dir=path.join(OUT,id);fs.mkdirSync(dir,{recursive:true});
  const audio=path.join(dir,"audio.wav"),voice=path.join(dir,"voice.mp3");
  try{
    failedStage="audio"; job(id,{status:"processing",stage:"audio",progress:15,error:null});
    const audioSource=await extractAudio(input,audio,opts.browserAudio);
    job(id,{stage:"audio",progress:30,audioSource});

    failedStage="transcription"; job(id,{stage:"transcription",progress:60});
    // IMPORTANT: Original SRT is now generated by Gemini from the extracted audio.
    // The user will manually copy the SRT to Gemini for Burmese translation.
    const key=opts.key;
    const b64=fs.readFileSync(audio).toString("base64");
    const original=cleanSrt(await gemini(
      "Create an accurate ORIGINAL-language subtitle transcript from this audio. Return ONLY valid SRT. Use sequential cue numbers and HH:MM:SS,mmm timestamps. Do not translate or explain.",
      key,b64
    ));
    if(!original.trim())throw new Error("Original subtitle မထွက်လာပါ။");
    fs.writeFileSync(path.join(dir,"original.srt"),original);

    // Stop here. User translates the SRT manually in Gemini.
    job(id,{
      status:"complete",
      stage:"original_srt_ready",
      progress:100,
      message:"Original SRT ready. Gemini မှာ Burmese ဘာသာပြန်ပြီး ပြန်တင်ပါ။",
      files:{
        originalSrt:"/api/download/"+id+"/original.srt"
      }
    });
  }catch(e){
    job(id,{status:"error",stage:"error",failedStage,progress:0,error:String(e.message||e)});
  }finally{
    try{fs.unlinkSync(input)}catch{}
    try{if(opts.browserAudio&&fs.existsSync(opts.browserAudio))fs.unlinkSync(opts.browserAudio)}catch{}
  }
}

async function createVoiceJob(id,burmeseSrt,opts){
  let failedStage="voice";
  const dir=path.join(OUT,id);fs.mkdirSync(dir,{recursive:true});
  const voice=path.join(dir,"voice.mp3");
  try{
    job(id,{status:"processing",stage:"voice",progress:70,error:null});
    const text=parseSrt(burmeseSrt).map(x=>x.text).join(" ");
    if(!text.trim())throw new Error("Burmese SRT ထဲမှာ စာသားမတွေ့ပါ။");
    await tts(text.trim(),voice);
    if(!fs.existsSync(voice)||fs.statSync(voice).size<1024)throw new Error("AI Voice ဖန်တီးမရပါ။");
    fs.writeFileSync(path.join(dir,"burmese.srt"),burmeseSrt);
    job(id,{
      status:"complete",stage:"voice_ready",progress:100,error:null,
      files:{
        originalSrt:"/api/download/"+id+"/original.srt",
        burmeseSrt:"/api/download/"+id+"/burmese.srt",
        voice:"/api/download/"+id+"/voice.mp3"
      }
    });
  }catch(e){
    job(id,{status:"error",stage:"error",failedStage,progress:0,error:String(e.message||e)});
  }
}

app.get("/api/health",(req,res)=>res.json({ok:true,app:"Lynn Movie Recap",version:"3.0.0",workflow:"audio-original-srt-manual-translation-ai-voice"}));
app.post("/api/process",upload.fields([
  {name:"video",maxCount:1},
  {name:"browserAudio",maxCount:1}
]),async(req,res)=>{
  const video=req.files?.video?.[0];
  const browserAudio=req.files?.browserAudio?.[0];
  if(!video)return res.status(400).json({error:"Video မရှိပါ"});
  const key=getKey(req);if(!key)return res.status(400).json({error:"Gemini API Key ထည့်ပါ"});
  const id=crypto.randomUUID();
  job(id,{status:"queued",stage:"queued",progress:3,audioBackup:!!browserAudio});
  processJob(id,video.path,{key,ratio:req.body.ratio,crf:req.body.crf,browserAudio:browserAudio?.path||null});
  res.json({jobId:id});
});

app.post("/api/voice",upload.single("burmeseSrt"),async(req,res)=>{
  const file=req.file;
  const pasted=String(req.body?.burmeseSrtText||"").trim();
  if(!file&&!pasted)return res.status(400).json({error:"Burmese SRT မရှိပါ"});
  const srt=file?fs.readFileSync(file.path,"utf8"):pasted;
  if(file){try{fs.unlinkSync(file.path)}catch{}}
  const id=crypto.randomUUID();
  job(id,{status:"queued",stage:"voice",progress:5});
  createVoiceJob(id,srt,{});
  res.json({jobId:id});
});

app.get("/api/status/:id",(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});res.json(j)});
app.get("/api/download/:id/:file",(req,res)=>{const allowed=["final.mp4","original.srt","burmese.srt","recap.txt","voice.mp3"];const file=path.basename(req.params.file);if(!allowed.includes(file))return res.status(400).send("Invalid file");const p=path.join(OUT,req.params.id,file);if(!fs.existsSync(p))return res.status(404).send("File not found");res.download(p,file)});
app.listen(PORT,()=>console.log("Lynn Movie Recap 3.0 running on "+PORT));