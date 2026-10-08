import {createServer,createConnection} from 'node:net';
import {chmod,lstat,realpath,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {invariant} from './safe.ts';
export type ChallengeRow='SF-GIFTCHALLENGE'|'AC-GIFTCHALLENGE';
export class ChallengeLogCapture {
  private streams=new Map<string,string>();
  private overflow=false;
  capture(app:string,stream:'stdout'|'stderr',chunk:string):void{
    const key=`${app}:${stream}`,text=(this.streams.get(key)??'')+chunk;
    if(text.length>16*1024*1024){this.overflow=true;return;}this.streams.set(key,text);
  }
  clean(app:string,codes:readonly string[]):boolean{
    if(this.overflow)return false;
    const streams=['stdout','stderr'].map(stream=>this.streams.get(`${app}:${stream}`)??'');
    return streams.every(text=>!/(gccp_[A-Za-z0-9_-]+|gccf_[A-Za-z0-9_.-]+|\/gift-card-challenge\/[^\s"?#]+)/.test(text)&&codes.every(code=>!text.includes(code)));
  }
}
export async function serveChallengeLogScan(directory:string,run:string,targetCommit:string,capture:ChallengeLogCapture):Promise<()=>Promise<void>>{
  const path=join(directory,'challenge-hygiene.sock');
  // An existing socket belongs to a different launch; never replace it.
  try{await lstat(path);throw new Error('CHALLENGE_SCAN_SOCKET_EXISTS');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const server=createServer(socket=>{
    let input='';socket.setTimeout(10000,()=>socket.destroy());
    socket.on('data',chunk=>{input+=chunk.toString();if(input.length>8192){socket.destroy();return;}if(!input.endsWith('\n'))return;
      try{const request=JSON.parse(input),keys=Object.keys(request).sort().join(',');
        invariant(keys==='app,codes,row,run,targetCommit'&&request.run===run&&request.targetCommit===targetCommit&&(request.row==='SF-GIFTCHALLENGE'&&request.app==='storefrontA'||request.row==='AC-GIFTCHALLENGE'&&request.app==='accountA')&&Array.isArray(request.codes)&&request.codes.length>0&&request.codes.length<=20&&request.codes.every((code:unknown)=>typeof code==='string'&&code.length>=6&&code.length<=200),'CHALLENGE_LOG_SCAN_REQUEST_INVALID');
        socket.end(JSON.stringify({clean:capture.clean(request.app,request.codes)})+'\n');
      }catch{socket.end('{"clean":false}\n');}
    });
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});await chmod(path,0o600);
  const inode=await lstat(path);
  return async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));try{const current=await lstat(path);if(current.ino===inode.ino&&current.dev===inode.dev)await unlink(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}};
}
export async function assertChallengeLogs(directory:string,run:string,targetCommit:string,row:ChallengeRow,codes:readonly string[]):Promise<void>{
  const path=join(directory,'challenge-hygiene.sock'),info=await lstat(path);
  invariant(info.isSocket()&&!info.isSymbolicLink()&&info.uid===process.getuid?.()&&(info.mode&0o077)===0&&await realpath(path)===path,'CHALLENGE_SCAN_SOCKET_IDENTITY_MISMATCH');
  const clean=await new Promise<boolean>((resolve,reject)=>{
    const socket=createConnection(path),request={run,targetCommit,row,app:row==='SF-GIFTCHALLENGE'?'storefrontA':'accountA',codes};let output='';
    socket.setTimeout(10000,()=>socket.destroy(new Error('CHALLENGE_LOG_SCAN_TIMEOUT')));socket.once('error',reject);
    socket.once('connect',()=>socket.write(JSON.stringify(request)+'\n'));socket.on('data',chunk=>{output+=chunk.toString();if(output.length>100)socket.destroy(new Error('CHALLENGE_LOG_SCAN_INVALID'));});
    socket.once('end',()=>{try{resolve(JSON.parse(output).clean===true);}catch{reject(new Error('CHALLENGE_LOG_SCAN_INVALID'));}});
  });
  const after=await lstat(path);invariant(info.ino===after.ino&&info.dev===after.dev&&clean,'CHALLENGE_AUTHORITY_IN_APP_LOGS');
}
