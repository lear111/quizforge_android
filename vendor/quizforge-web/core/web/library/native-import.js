// The launcher supplies only an installed bank route, never a local file path.
// Consuming the hint prevents refresh/back from looking like another import.
export function takeImportedBank(catalog, location=window.location, history=window.history){
  const url=new URL(location.href),id=url.searchParams.get('imported-bank');
  if(id===null||!catalog.canManage)return null;
  url.searchParams.delete('imported-bank');history.replaceState(history.state,'',url.href);
  return catalog.banks.find(row=>row.id===id&&!row.error)||null;
}
