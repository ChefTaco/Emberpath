import http from 'node:http';
import https from 'node:https';
const url=new URL(process.env.HIVE_HEALTH_URL);
if(!['http:','https:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password)process.exit(1);
const request=(url.protocol==='https:'?https:http).get(url,{timeout:3000,...(process.env.HIVE_HEALTH_TLS_NAME?{servername:process.env.HIVE_HEALTH_TLS_NAME}:{})},response=>{response.resume();process.exitCode=response.statusCode===200?0:1;});
request.on('timeout',()=>request.destroy());
request.on('error',()=>{process.exitCode=1;});
