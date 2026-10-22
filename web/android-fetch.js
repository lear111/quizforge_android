/** Transport only: the original Web application still owns rendering and interaction. */
export function installOfflineFetch({services,fetch:originalFetch=globalThis.fetch,origin=location.origin,target=globalThis}){
  const fallback=originalFetch.bind(target);
  target.fetch=async(input,init={})=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,origin);
    if(url.origin!==origin||!url.pathname.startsWith('/api/'))return fallback(input,init);
    const signal=init.signal||(typeof input==='object'?input.signal:null);
    if(signal?.aborted)throw new DOMException('The operation was aborted.','AbortError');
    const method=(init.method||input.method||'GET').toUpperCase();
    const headers=Object.fromEntries(new Headers(init.headers||input.headers||{}).entries());
    let body=init.body;
    if(body===undefined&&typeof input==='object'&&typeof input.clone==='function'&&!['GET','HEAD'].includes(method))body=await input.clone().text();
    const operation=async()=>{try{
      if(typeof body==='string'&&body.length)body=JSON.parse(body);
      const request={path:url.pathname+url.search,method,headers,body:body??null};
      let value;
      for(const service of services){value=await service.handle(request);if(value!==undefined)break;}
      if(value===undefined)throw Object.assign(Error('当前离线版本尚未提供此功能'),{status:501,code:'OFFLINE_ACTION_UNAVAILABLE'});
      if(value?.__qfBinary){
        const bytes=Uint8Array.from(atob(value.data),char=>char.charCodeAt(0));
        return new Response(bytes,{status:200,headers:{'Content-Type':value.mime,'Cache-Control':'no-store'}});
      }
      return new Response(JSON.stringify(value??null),{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
    }catch(error){
      return new Response(JSON.stringify({error:{code:error.code||'LOCAL_OPERATION_FAILED',message:error.message||'本地操作未完成，请保留输入后重试'}}),{status:Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:error.code==='REVISION_CONFLICT'||error.code==='CONTENT_CONFLICT'?409:400,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
    }};
    if(!signal)return operation();
    // An abort stops waiting, while an already accepted durable mutation keeps
    // running. Its original requestId lets the Web write queue retry safely.
    return new Promise((resolve,reject)=>{
      const abort=()=>reject(new DOMException('The operation was aborted.','AbortError'));
      signal.addEventListener('abort',abort,{once:true});
      operation().then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
  };
  return ()=>{target.fetch=originalFetch;};
}
