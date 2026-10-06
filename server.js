const express=require("express");const multer=require("multer");const fs=require("fs");const path=require("path");const crypto=require("crypto");const {GoogleGenerativeAI}=require("@google/generative-ai");const ffmpeg=require("ffmpeg-static");const ffprobe=require("ffprobe-static");const {execFile}=require("child_process");
const app=express();const PORT=process.env.PORT||10000;const ROOT=__dirname;const UP=path.join(ROOT,"uploads");const OUT=path.join(ROOT,"outputs");fs.mkdirSync(UP,{recursive:true});fs.mkdirSync(OUT,{recursive:true});
const upload=multer({dest:UP,limits:{fileSize:(Number(process.env.MAX_FILE_MB)||500)*1024*1024}});app.use(express.json({limit:"2mb"}));app.use(express.static(path.join(ROOT,"public")));
const run=(bin,args)=>new Promise((resolve,reject)=>{execFile(bin,args,{maxBuffer:20*1024*1024},(error,stdout,stderr)=>{if(error)return reject(new Error(stderr||error.message));resolve(stdout);});});
function key(req){return req.headers["x-gemini-api-key"]||process.env.GEMINI_API_KEY}
const MODELS=["gemini-3.8-flash","gemini-3.7-flash","gemini-3.6-flash","gemini-3.5-flash-lite"];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function generateWithFallback(gen,content){
  let last;
  for(const modelName of MODELS){
    const model=gen.getGenerativeModel({model:modelName});
    for(let attempt=0;attempt<2;attempt++){
      try{return await model.generateContent(content)}
      catch(e){
        last=e;
        const msg=String(e?.message||e);
        const unavailable=/503|UNAVAILABLE|high demand|overloaded/i.test(msg);
        if(!unavailable)throw e;
        if(attempt===0)await sleep(1500);
      }
    }
  }
  throw last||new Error("Gemini service temporarily unavailable");
}
app.get("/api/health",(req,res)=>res.json({ok:true,app:"Lynn Movie Recap New",version:"1.0.0"}));
function srtTime(sec){
  const ms=Math.max(0,Math.round(sec*1000)), h=Math.floor(ms/3600000), m=Math.floor((ms%3600000)/60000), s=Math.floor((ms%60000)/1000), x=ms%1000;
  return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0")+","+String(x).padStart(3,"0");
}
function cleanSrt(text){
  text=String(text||"").replace(/```srt/gi,"").replace(/```/g,"").trim();
  const m=text.match(/\d+\s*\n\d\d:\d\d:\d\d,\d{3}\s*-->\s*\d\d:\d\d:\d\d,\d{3}[\s\S]*/);
  return (m?m[0]:text).trim();
}
function extractSrtBlocks(srt){
  return srt.split(/\n\s*\n/).map(b=>{
    const lines=b.split(/\r?\n/), ti=lines.findIndex(x=>x.includes("-->"));
    if(ti<0)return null;
    const mm=lines[ti].match(/(\d\d:\d\d:\d\d,\d{3})\s*-->\s*(\d\d:\d\d:\d\d,\d{3})/);
    if(!mm)return null;
    return {start:mm[1],end:mm[2],text:lines.slice(ti+1).join(" ").trim()};
  }).filter(Boolean);
}
async function makeTts(text,file){
  const {ttsSave}=require("edge-tts");
  await ttsSave(text,file,{voice:"my-MM-ThihaNeural",rate:"-5%",volume:"+0%",pitch:"+0Hz"});
}
app.post("/api/process",upload.single("video"),async(req,res)=>{
  let v,a,originalSrt,translatedSrt,voice,out;
  try{
    if(!req.file)throw Error("Video မရှိပါ");
    const k=key(req);if(!k)throw Error("Gemini API Key ထည့်ပါ");
    v=req.file.path;
    const id=crypto.randomUUID();
    a=path.join(OUT,id+".wav");originalSrt=path.join(OUT,id+"-original.srt");translatedSrt=path.join(OUT,id+"-my.srt");voice=path.join(OUT,id+"-voice.mp3");out=path.join(OUT,id+".mp4");
    await run(ffmpeg,["-y","-i",v,"-vn","-ac","1","-ar","16000","-c:a","pcm_s16le",a]);
    const audio=fs.readFileSync(a).toString("base64");
    const gen=new GoogleGenerativeAI(k);
    const trans=await generateWithFallback(gen,[{inlineData:{data:audio,mimeType:"audio/wav"}},{text:"Create an accurate ORIGINAL-language subtitle transcript from this audio. Return ONLY valid SRT format with sequential cue numbers, timestamps in HH:MM:SS,mmm --> HH:MM:SS,mmm, and the exact spoken words. Do not translate. Do not explain."}]);
    const srt=cleanSrt(trans.response.text());
    fs.writeFileSync(originalSrt,srt);
    const tr=await generateWithFallback(gen,"Translate every subtitle line below into natural, conversational Burmese. Keep ALL cue numbers and timestamps EXACTLY unchanged. Return ONLY valid SRT. Do not add or remove cues.\n\n"+srt);
    const mySrt=cleanSrt(tr.response.text());
    fs.writeFileSync(translatedSrt,mySrt);
    const blocks=extractSrtBlocks(mySrt);
    const speech=blocks.map(x=>x.text).join(" ");
    await makeTts(speech,voice);
    const dur=Number((await run(ffprobe.path,["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",v])).trim())||0;
    const ratio=req.body.ratio||"9:16",crf=Math.max(24,Math.min(32,Number(req.body.crf)||28));
    let vf=ratio==="16:9"?"scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2":ratio==="1:1"?"scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2":"scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2";
    await run(ffmpeg,["-y","-i",v,"-i",voice,"-vf",vf,"-map","0:v:0","-map","1:a:0","-af","apad","-t",String(dur),"-c:v","libx264","-preset","veryfast","-crf",String(crf),"-c:a","aac","-b:a","128k","-movflags","+faststart",out]);
    for(const p of [v,a,voice])try{fs.unlinkSync(p)}catch{}
    res.json({download:"/api/download/"+path.basename(out),originalSrt:"/api/download/"+path.basename(originalSrt),translatedSrt:"/api/download/"+path.basename(translatedSrt)});
  }catch(e){
    for(const p of [v,a,voice])if(p)try{fs.unlinkSync(p)}catch{}
    res.status(500).json({error:e.message});
  }
});
app.get("/api/download/:file",(req,res)=>{const f=path.basename(req.params.file);const p=path.join(OUT,f);if(!fs.existsSync(p))return res.status(404).send("File not found");res.download(p,"lynn-recap.mp4",()=>{try{fs.unlinkSync(p)}catch{}})});
app.listen(PORT,()=>console.log("Lynn Movie Recap New running on "+PORT));