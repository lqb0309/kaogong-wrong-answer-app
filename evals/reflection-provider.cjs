// Optional paid evaluation adapter: reuses the production generateReflection,
// but never opens a learning database, reads stored secrets, or writes a Vault.
const fs=require('node:fs'), path=require('node:path'), ts=require('typescript')
function compile(file, deps) {
  const mod={exports:{}}
  const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
  new Function('require','module','exports',code)(key=>key in deps?deps[key]:require(key),mod,mod.exports)
  return mod.exports
}
module.exports=class ReflectionProvider {
  id(){return 'study-production-reflection'}
  async callApi(prompt){
    if(process.env.STUDY_EVAL_ALLOW_PAID!=='yes')return {error:'付费评估未启用。只有明确设置 STUDY_EVAL_ALLOW_PAID=yes 才允许模型调用。'}
    if(!process.env.STUDY_EVAL_API_KEY||!process.env.STUDY_EVAL_BASE_URL||!process.env.STUDY_EVAL_MODEL)return {error:'请显式提供评估专用模型、接口地址和密钥；不会读取应用中的凭据。'}
    try {
      const url=new URL(process.env.STUDY_EVAL_BASE_URL)
      if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw Error('评估接口需要HTTPS，或显式本地测试服务')
      const params=JSON.parse(prompt)
      if(params.imageUrls?.length||/!\[/.test(params.officialAnalysis||''))throw Error('此文本评估适配器不处理真实图片，图表读取另有离线测试')
      let tokens=0
      const api=compile('src/main/ai.ts',{
        './ai-validation':compile('src/main/ai-validation.ts',{}),
        './config':{readConfig:key=>({ai_api_key:process.env.STUDY_EVAL_API_KEY,ai_base_url:process.env.STUDY_EVAL_BASE_URL,ai_model:process.env.STUDY_EVAL_MODEL})[key]},
        './safe-storage':{decryptToken:value=>value},'./tag-service':{getTagTree:()=>[]},
        './logger':{logger:{info(){},warn(){},error(){},debug(){}}},
        './utils':{generateTraceId:()=> 'paid-eval',toImageUrl:value=>value},
        './image-assets':{readImageBuffer:()=>{throw Error('评估禁止读取本地学习图片')}},
        './ai-usage':{recordAiUsage:response=>{tokens+=response.usage?.total_tokens||0}}
      })
      return {output:await api.generateReflection(params),tokenUsage:{total:tokens}}
    }catch(error){return {error:error.message}}
  }
}
