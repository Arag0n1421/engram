import {mkdtemp, cp, rm, readFile, writeFile, readdir, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, basename, delimiter, relative, sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Engram verification requires Node 24.x.');
const source=resolve(import.meta.dirname,'..');
const scratch=await mkdtemp(resolve(tmpdir(),'engram-clean-'));
const blocked=new Set(['node_modules','.git','.eve','.npmrc','.output','.next','.nitro','.vercel','state','evidence','work','dist']);
async function hashSourceTree(root,dir=root,files=[]) {
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const path=resolve(dir,entry.name);
    if(entry.isDirectory()) await hashSourceTree(root,path,files);
    else if(entry.isFile()) files.push({path:relative(root,path).split(sep).join('/'),sha256:createHash('sha256').update(await readFile(path)).digest('hex')});
  }
  return files;
}
try {
  await cp(source,scratch,{recursive:true,filter:path=>{
    const name=basename(path);
    return !blocked.has(name) && name !== "dist 2" && !name.startsWith(".output-") && !name.startsWith(".output.__PRE_") && !name.startsWith(".engram-") && !name.startsWith("node_modules.__PRE_") && !name.startsWith("dist-") && (name==='.env.example' || !name.startsWith('.env'));
  }});
  const sourceHashes=await hashSourceTree(scratch);
  const npmCli=process.env.npm_execpath;
  if (!npmCli) throw new Error('Run through npm run verify:clean so the active npm CLI is portable.');
  const emptyUserNpmConfig=resolve(scratch,'.npmrc.empty-user');
  const emptyGlobalNpmConfig=resolve(scratch,'.npmrc.empty-global');
  await Promise.all([writeFile(emptyUserNpmConfig,''),writeFile(emptyGlobalNpmConfig,'')]);
  const offline=process.env.ENGRAM_CLEAN_OFFLINE==='1';
  const env={
    PATH:resolve(process.execPath,'..')+delimiter+(process.env.PATH??''),
    npm_execpath:npmCli,
    ...(process.env.npm_config_cache?{npm_config_cache:process.env.npm_config_cache}:{}),
    ...(offline?{npm_config_offline:'true'}:{}),
    npm_config_userconfig:emptyUserNpmConfig,
    npm_config_globalconfig:emptyGlobalNpmConfig,
    ...(process.env.TMPDIR?{TMPDIR:process.env.TMPDIR}:{}),
    RECALLOPS_DATA_MODE:'replay',
    RECALLOPS_ALLOW_INFERENCE:'false',
    RECALLOPS_STATE_DIR:resolve(scratch,'state'),
    EVE_TELEMETRY_DISABLED:'1',
  };
  const installArgs=['ci',...(offline?['--offline']:[]),'--no-audit','--no-fund'];
  for(const args of [installArgs,['test'],['run','typecheck'],['run','build']]) {
    console.log(`Engram clean verification: npm ${args.join(' ')}`);
    const run=spawnSync(process.execPath,[npmCli,...args],{cwd:scratch,env,stdio:'inherit'});
    if(run.status!==0) throw new Error(`Clean verification failed: npm ${args[0]} (${run.status})`);
  }
  const proof={status:'passed',node:process.version,package:JSON.parse(await readFile(resolve(scratch,'package.json'),'utf8')).name,checks:[offline?'offline npm ci':'npm ci','tests','typecheck','build'],npmCache:offline?'active npm cache; offline install only':'npm cache; public npm registry allowed',dataMode:'replay',inference:false};
  console.log(JSON.stringify(proof));
  const exportDir=process.env.ENGRAM_CLEAN_EXPORT_DIR;
  if(exportDir) {
    const destination=resolve(exportDir);
    await mkdir(destination);
    await cp(resolve(scratch,'.output'),resolve(destination,'.output'),{recursive:true});
    await cp(resolve(scratch,'web','dist'),resolve(destination,'web-dist'),{recursive:true});
    await writeFile(resolve(destination,'source-hashes.json'),JSON.stringify({algorithm:'sha256',files:sourceHashes},null,2)+'\n');
    await writeFile(resolve(destination,'proof.json'),JSON.stringify(proof,null,2)+'\n');
  }
} finally {await rm(scratch,{recursive:true,force:true});}
