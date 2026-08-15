// nav scrolled
const nav=document.getElementById('nav');
addEventListener('scroll',()=>{nav.classList.toggle('scrolled',scrollY>10)},{passive:true});
// mobile menu
const sheet=document.getElementById('msheet');
document.getElementById('hamb').onclick=()=>sheet.classList.add('open');
document.getElementById('mclose').onclick=()=>sheet.classList.remove('open');
sheet.querySelectorAll('a').forEach(a=>a.onclick=()=>sheet.classList.remove('open'));
sheet.onclick=e=>{if(e.target===sheet)sheet.classList.remove('open')};
// program tabs
const ptabs=document.querySelectorAll('.tabbar .tab');
function openTab(id){
  ptabs.forEach(t=>t.classList.toggle('active',t.dataset.t===id));
  document.querySelectorAll('.tpanel').forEach(p=>p.classList.toggle('active',p.id===id));
}
ptabs.forEach(t=>t.onclick=()=>openTab(t.dataset.t));
document.querySelectorAll('a[href="#loop"],a[href="#special"],a[href="#tutor"]').forEach(a=>{
  a.addEventListener('click',()=>openTab(a.getAttribute('href').slice(1)));
});
// open tab from URL hash (program page deep-link)
if(location.hash){
  const id=location.hash.slice(1);
  if(document.getElementById(id) && document.getElementById(id).classList.contains('tpanel')) openTab(id);
}

