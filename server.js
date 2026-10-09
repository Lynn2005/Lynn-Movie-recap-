const express=require("express");
const multer=require("multer");
const fs=require("fs");
const path=require("path");
const crypto=require("crypto");
const {GoogleGenerativeAI}=require("@google/generative-ai");
const ffmpeg=require("ffmpeg-static");
const {execFile}=require("child_process");
const ENV=(globalThis.process&&globalThis.process.env)?globalThis.process.env:{};
const app=express(),PORT=ENV.PORT||10000;
const ROOT=__dirname,UPLOAD=path.join(ROOT,"uploads"),OUT=path.join(ROOT,"outputs");
fs.mkdirSync(UPLOAD,{recursive:true});fs.mkdirSync(OUT,{recursive:true});
const upload=multer({dest:UPLOAD,limits:{fileSize:(Number(ENV.MAX_FILE_MB)||500)*1024*1024}});
app.use(express.json({limit:"5mb"}));app.use(express.static(path.join(ROOT,"public")));
const jobs=new Map();
const run=(bin,args)=>new Promise((ok,no)=>execFile(bin,args,{maxBuffer:30*1024*1024},(e,o,s)=>e?no(new Error(s||e.message)):ok(o)));
const setJob=(id,x)=>jobs.set(id,{...(jobs.get(id)||{}),...x,updatedAt:Date.now()});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function key(req){return req.headers["x-gemini-api-key"]||ENV.GEMINI_API_KEY}
function clean(s){return String(s||"").replace(/^\s*```(?:srt|text)?/i,"").replace(/```\s*$/,"").trim()}
function parseSrt(s){return s.split(/\n\s*\n/).map(b=>{let a=b.split(/\r?\n/),i=a.findIndex(x=>x.includes("-->"));return i<0?null:a.slice(i+1).join(" ").trim()}).filter(Boolean)}
async function geminiAudio(audio,k,requested){
 const models=[requested,ENV.GEMINI_MODEL,"gemini-2.5-flash","gemini-2.0-flash"].filter(Boolean);
 let last;
 for(const name of [...new Set(models)]){
  const m=new GoogleGenerativeAI(k).getGenerativeModel({model:name});
  for(let i=0;i<2;i++){try{
   return (await m.generateContent([{inlineData:{data:fs.readFileSync(audio).toString("base64"),mimeType:"audio/wav"}},{text:"Transcribe this audio accurately in its ORIGINAL spoken language. Return ONLY valid SRT with sequential numbers and HH:MM:SS,mmm timestamps. Do not translate. Do not explain."}])).response.text();
  }catch(e){last=e;if(!/404|not found|model.*not found|503|429|UNAVAILABLE|overloaded|high demand|quota|resource exhausted/i.test(String(e.message)))break;await wait(1000*(i+1))}}
 }
 throw last||new Error("Gemini model မရပါ။")
}
async function process(id,input,k,requested){
 const dir=path.join(OUT,id);fs.mkdirSync(dir,{recursive:true});const audio=path.join(dir,"audio.wav");
 try{
  setJob(id,{status:"processing",stage:"audio",progress:15,message:"Audio ထုတ်နေပါတယ်..."});
  await run(ffmpeg,["-y","-nostdin","-hide_banner","-loglevel","error","-i",input,"-map","0:a:0","-vn","-ac","1","-ar","16000","-c:a","pcm_s16le","-f","wav",audio]);
  if(!fs.existsSync(audio)||fs.statSync(audio).size<2048)throw Error("Video ထဲမှာ Audio မတွေ့ပါ။");
  setJob(id,{stage:"srt",progress:55,message:"Original SRT ဖန်တီးနေပါတယ်..."});
  const s=clean(await geminiAudio(audio,k,requested));if(!s)throw Error("Original SRT မထွက်လာပါ။");
  fs.writeFileSync(path.join(dir,"original.srt"),s);
  setJob(id,{status:"complete",stage:"original_ready",progress:100,message:"Original SRT အဆင်သင့်ပါပြီ",files:{originalSrt:"/api/download/"+id+"/original.srt"}});
 }catch(e){setJob(id,{status:"error",stage:"error",progress:0,error:e.message||String(e)})}
 finally{try{fs.unlinkSync(input)}catch{}try{fs.unlinkSync(audio)}catch{}}
}
async function voiceJob(id,srt){
 const dir=path.join(OUT,id),mp3=path.join(dir,"voice.mp3");fs.mkdirSync(dir,{recursive:true});
 try{setJob(id,{status:"processing",stage:"voice",progress:30,message:"Burmese AI Voice ထုတ်နေပါတယ်..."});
  const text=parseSrt(srt).join(" ");if(!text)throw Error("Burmese SRT စာသားမတွေ့ပါ။");
  const {ttsSave}=require("edge-tts");await ttsSave(text,mp3,{voice:ENV.TTS_VOICE||"my-MM-ThihaNeural",rate:"-5%",volume:"+0%",pitch:"+0Hz"});
  fs.writeFileSync(path.join(dir,"burmese.srt"),srt);
  setJob(id,{status:"complete",stage:"voice_ready",progress:100,message:"AI Voice အဆင်သင့်ပါပြီ",files:{voice:"/api/download/"+id+"/voice.mp3",burmeseSrt:"/api/download/"+id+"/burmese.srt"}});
 }catch(e){setJob(id,{status:"error",stage:"error",progress:0,error:e.message||String(e)})}
}

app.post("/api/render",(req,res,next)=>{upload.fields([{name:"video",maxCount:1},{name:"voice",maxCount:1}])(req,res,async e=>{
 if(e)return next(e);
 const video=req.files&&req.files.video&&req.files.video[0],voice=req.files&&req.files.voice&&req.files.voice[0];
 if(!video||!voice){for(const x of [video,voice])if(x)try{fs.unlinkSync(x.path)}catch{};return res.status(400).json({error:"Original video နဲ့ AI voice နှစ်ခုလုံးထည့်ပါ။"})}
 const id=crypto.randomUUID(),dir=path.join(OUT,id);fs.mkdirSync(dir,{recursive:true});
 try{
  const srt=clean(req.body.burmeseSrt||"");if(!srt)throw Error("Burmese SRT ထည့်ပါ။");
  const srtPath=path.join(dir,"burmese.srt"),out=path.join(dir,"final.mp4");
  fs.writeFileSync(srtPath,srt);
  const filters=[];
  if(req.body.mirror==="true")filters.push("hflip");
  const blur=Math.max(0,Math.min(20,Number(req.body.blur)||0));if(blur>0)filters.push("boxblur="+blur+":1");
  const subtitleSize=Math.max(12,Math.min(48,Number(req.body.subtitleSize)||24));
  const escaped=srtPath.replace(/\\/g,"/").replace(/:/g,"\\:").replace(/'/g,"\\'");
  filters.push("subtitles='"+escaped+"':force_style='FontSize="+subtitleSize+",Outline=2,Shadow=1,Alignment=2,MarginV=35'");
  const title=String(req.body.overlayText||"").trim().slice(0,100).replace(/\\/g,"").replace(/'/g,"\\'").replace(/:/g,"\\:");
  if(title)filters.push("drawtext=text='"+title+"':fontcolor=white:fontsize=28:borderw=2:bordercolor=black:x=(w-text_w)/2:y=30");
  setJob(id,{status:"processing",stage:"render",progress:10,message:"Final video တည်ဆောက်နေပါတယ်..."});
  const args=["-y","-nostdin","-hide_banner","-loglevel","error","-i",video.path,"-i",voice.path,"-map","0:v:0","-map","1:a:0","-vf",filters.join(","),"-c:v","libx264","-preset","ultrafast","-crf","24","-c:a","aac","-b:a","128k","-shortest","-movflags","+faststart",out];
  await run(ffmpeg,args);
  if(!fs.existsSync(out)||fs.statSync(out).size<1024)throw Error("Final video မထွက်လာပါ။");
  setJob(id,{status:"complete",stage:"render_ready",progress:100,message:"Final video အဆင်သင့်ပါပြီ",files:{finalVideo:"/api/download/"+id+"/final.mp4"}});
  res.json({jobId:id});
 }catch(err){setJob(id,{status:"error",stage:"error",progress:0,error:err.message||String(err)});res.status(400).json({error:err.message||"Render failed"})}
 finally{for(const x of [video,voice])if(x)try{fs.unlinkSync(x.path)}catch{}}
})});

app.get("/api/health",(q,r)=>r.json({ok:true,version:"5.1.0",freeAI:true,models:["gemini-2.5-flash","gemini-2.0-flash"],tts:"edge-tts"}));
app.post("/api/process",(req,res,next)=>{upload.single("video")(req,res,e=>{if(e)return next(e);const f=req.file;if(!f)return res.status(400).json({error:"Video ရွေးပါ"});const k=key(req),requested=req.headers["x-gemini-model"];if(!k){try{fs.unlinkSync(f.path)}catch{};return res.status(400).json({error:"Gemini API Key ထည့်ပါ"})}const id=crypto.randomUUID();setJob(id,{status:"queued",stage:"upload",progress:5});process(id,f.path,k,requested);res.json({jobId:id})})});
app.post("/api/voice",(req,res,next)=>{upload.single("burmeseSrt")(req,res,e=>{if(e)return next(e);let s=req.file?fs.readFileSync(req.file.path,"utf8"):String(req.body.burmeseSrtText||"");if(req.file)try{fs.unlinkSync(req.file.path)}catch{};if(!s.trim())return res.status(400).json({error:"Burmese SRT တင်ပါ"});const id=crypto.randomUUID();setJob(id,{status:"queued",stage:"voice",progress:5});voiceJob(id,s);res.json({jobId:id})})});
app.get("/api/status/:id",(req,res)=>{const j=jobs.get(req.params.id);j?res.json(j):res.status(404).json({error:"Job not found"})});
app.get("/api/download/:id/:file",(req,res)=>{const f=path.basename(req.params.file),ok=["original.srt","burmese.srt","voice.mp3","final.mp4"].includes(f);if(!ok)return res.status(400).send("Invalid file");const p=path.join(OUT,req.params.id,f);fs.existsSync(p)?res.download(p,f):res.status(404).send("File not found")});
app.use((e,req,res,next)=>{if(e instanceof multer.MulterError)return res.status(e.code==="LIMIT_FILE_SIZE"?413:400).json({error:e.code==="LIMIT_FILE_SIZE"?"Video 500MB ထက် မကျော်ရပါ။":"Upload error: "+e.message});res.status(500).json({error:e.message||"Server error"})});
app.listen(PORT,()=>console.log("Lynn Recap 5.1 on "+PORT));
