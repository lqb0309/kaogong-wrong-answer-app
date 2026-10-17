// Local, recoverable installation. No credentials, Vault or learning records are rewritten.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{execFileSync,spawnSync}=require('node:child_process')
const identifier='com.deca.wrong-answer.tauri',appName='小乖的考公错题屋.app'
const register='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function plist(bundle,key){return execFileSync('/usr/libexec/PlistBuddy',['-c','Print :'+key,path.join(bundle,'Contents/Info.plist')],{encoding:'utf8'}).trim()}
function verify(bundle){
  if(plist(bundle,'CFBundleIdentifier')!==identifier)throw Error('安装源不是预期的 Tauri 新版')
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{stdio:'pipe'})
}
function closed(file){
  if(!fs.existsSync(file))return
  const open=spawnSync('/usr/sbin/lsof',['-t',file],{encoding:'utf8'})
  if(open.status===0&&open.stdout.trim())throw Error('程序仍在使用文件，请先正常退出新旧版本：'+file)
  if(open.error||(open.status!==0&&open.status!==1))throw Error('无法确认程序是否已关闭')
}
function snapshot(file,to){
  if(!fs.existsSync(file))return
  fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o700})
  for(const suffix of ['', '-wal'])if(fs.existsSync(file+suffix)){
    const before=hash(file+suffix);fs.copyFileSync(file+suffix,to+suffix);fs.chmodSync(to+suffix,0o600)
    if(hash(to+suffix)!==before||hash(file+suffix)!==before)throw Error('数据库快照期间文件有变化，已取消安装')
  }
}
function install(source){
  if(process.platform!=='darwin')throw Error('此安装工具仅适用于 macOS')
  if(!source||!path.isAbsolute(source)||!source.endsWith('.app')||fs.lstatSync(source).isSymbolicLink())throw Error('需要明确的已构建 .app 目录')
  verify(source)
  const home=os.homedir(),profile=path.join(home,'Library/Application Support',identifier),dest=path.join('/Applications',appName),userDest=path.join(home,'Applications',appName)
  if(fs.realpathSync(source)===dest)throw Error('安装源不能是已安装位置')
  const databases=[path.join(profile,'data.db'),path.join(home,'Library/Application Support/wrong-answer-app/data.db')]
  databases.forEach(closed)
  for(const bundle of [source,dest,userDest])if(fs.existsSync(bundle)){
    if(![identifier,'com.deca.wrong-answer-app'].includes(plist(bundle,'CFBundleIdentifier')))throw Error('目标目录不是本应用，拒绝覆盖')
    closed(path.join(bundle,'Contents/MacOS',plist(bundle,'CFBundleExecutable')))
  }
  const backupRoot=path.join(profile,'installation-backups');fs.mkdirSync(backupRoot,{recursive:true,mode:0o700})
  const backup=fs.mkdtempSync(path.join(backupRoot,'v'+plist(source,'CFBundleShortVersionString')+'-'))
  databases.forEach((file,index)=>snapshot(file,path.join(backup,index?'electron-data-before':'tauri-data-before','data.db')))
  const staged=path.join('/Applications','.xiaoguai-install-'+crypto.randomUUID()+'.app')
  execFileSync('/usr/bin/ditto',[source,staged],{stdio:'pipe'});verify(staged)
  const moved=[];let installed=false,alias=false
  try{
    for(const [bundle,label] of [[dest,'system-old.app.saved'],[userDest,'user-old.app.saved']]){
      if(!fs.existsSync(bundle)&&!fs.lstatSync(path.dirname(bundle)).isDirectory())throw Error('安装目录不存在')
      if(fs.existsSync(bundle)||fs.lstatSync(bundle,{throwIfNoEntry:false})){
        spawnSync(register,['-u',bundle],{stdio:'pipe'})
        const saved=path.join(backup,label);fs.renameSync(bundle,saved);moved.push([bundle,saved])
      }
    }
    fs.renameSync(staged,dest);installed=true
    fs.mkdirSync(path.dirname(userDest),{recursive:true});fs.symlinkSync(dest,userDest);alias=true
    verify(dest)
    execFileSync(register,['-f',dest],{stdio:'pipe'})
    const oldBuild=path.join(path.dirname(source),'小乖错题屋-Tauri迁移版.app')
    if(fs.existsSync(oldBuild))spawnSync(register,['-u',oldBuild],{stdio:'pipe'})
    const report={installed:dest,userShortcut:userDest,version:plist(dest,'CFBundleShortVersionString'),identifier,backup,originalApps:moved.map(([original,saved])=>({original,saved})),dataLocationsUnchanged:true}
    fs.writeFileSync(path.join(backup,'installation-report.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600})
    return report
  }catch(error){
    if(alias&&fs.lstatSync(userDest,{throwIfNoEntry:false})?.isSymbolicLink())fs.unlinkSync(userDest)
    if(installed&&fs.existsSync(dest))fs.renameSync(dest,path.join(backup,'failed-new.app.saved'))
    for(const [original,saved] of moved.reverse())if(!fs.existsSync(original))fs.renameSync(saved,original)
    if(fs.existsSync(staged))fs.renameSync(staged,path.join(backup,'uninstalled-stage.app.saved'))
    throw error
  }
}
if(require.main===module){try{console.log(JSON.stringify(install(process.argv[2])))}catch(error){console.error(error.message);process.exitCode=1}}
module.exports={install}
