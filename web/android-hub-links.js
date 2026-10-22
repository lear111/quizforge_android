const HUB_ORIGIN='https://quizforge.treenewbee.cloud';
const hubPage=url=>{try{const value=new URL(url);return value.origin===HUB_ORIGIN&&!value.username&&!value.password;}catch{return false;}};

/** The Web login dialog and user center open Hub pages in a new browser window.
 * On Android those pages open in Custom Tabs (Hub docs/HUB_CONNECT_AI.md 7.2), never in the app WebView. */
export function bindHubLinks({nativeCall,target=globalThis,document=globalThis.document,notice=()=>{}}){
  const original=target.open;
  const browse=url=>nativeCall('hub.browse',{url:String(url)}).catch(notice);
  target.open=function(url,...rest){
    if(hubPage(String(url??'')))return void browse(url),null;
    return original?.call(target,url,...rest)??null;
  };
  const click=event=>{
    const link=event.target?.closest?.('#hub-login-link,#user-center-manage');
    if(!link||!hubPage(link.href))return;
    event.preventDefault();event.stopImmediatePropagation();browse(link.href);
  };
  document.addEventListener('click',click,true);
  return ()=>{target.open=original;document.removeEventListener('click',click,true);};
}
