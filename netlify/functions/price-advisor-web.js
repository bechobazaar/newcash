<script>
// ====== Netlify base auto-pick (works even if frontend is not on Netlify) ======
const NETLIFY_BASE = (
  location.hostname.endsWith('.netlify.app') ||
  location.hostname === 'bechobazaar.netlify.app'
) ? '' : 'https://bechobazaar.netlify.app';
const PRICE_ADVISOR_URL = `${NETLIFY_BASE}/.netlify/functions/price-advisor-web`;

// ====== Eligible categories only ======
function isAIEligible(cat){ return ['Cars','Bikes','Mobiles'].includes(String(cat||'')); }
function toggleAdvisorForCategory(){
  const cat = document.getElementById('category')?.value || '';
  const box = document.getElementById('advisorBox');
  if(!box) return;
  box.hidden = !isAIEligible(cat);
}

// ====== Small helpers ======
function rupees(n){
  const s = (''+Math.round(Number(n)||0));
  if(s.length<=3) return '₹'+s;
  const last3 = s.slice(-3);
  const other = s.slice(0,-3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return '₹'+other+','+last3;
}
function pick(v){ return (v==null?'':String(v)).trim(); }
function num(v, d=0){ const n = Number(v); return Number.isFinite(n) ? n : d; }

// ====== Extract meta directly from Description (no extra fields) ======
function extractMetaFromDescription(){
  const html = quill?.root?.innerHTML || '';
  const text = (html||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().toLowerCase();

  // Condition
  let condition = 'Good';
  if (/(scratchless|mint|excellent|like\s*new)/.test(text)) condition = 'Like New / Excellent';
  else if (/\bnew\b|sealed/.test(text)) condition = 'New (sealed)';
  else if (/very good/.test(text)) condition = 'Very Good';
  else if (/\bfair\b|used/.test(text)) condition = 'Fair';
  else if (/poor|broken|crack|damaged/.test(text)) condition = 'Poor';

  // Bill/Box
  const billBox = /(bill|invoice|box|charger|accessories)/.test(text);

  // Age
  let age = '';
  const m = text.match(/(\d+)\s*(month|months|yr|year|years?)/);
  if (m) age = m[1] + ' ' + (m[2].includes('month') ? 'months' : 'years');

  return { condition, billBox, age, desc: html };
}

// ====== Read vehicle extras (Cars/Bikes tab fields) ======
function readVehicleFields(){
  return {
    kmDriven: pick(document.getElementById('kmDriven')?.value),
    yearOfPurchase: pick(document.getElementById('yearOfPurchase')?.value),
    tyreCondition: pick(document.getElementById('tyreCondition')?.value),
    accidentStatus: pick(document.getElementById('accidentStatus')?.value),
    allPapersAvailable: pick(document.getElementById('allPapersAvailable')?.value),
    pollutionExpiry: pick(document.getElementById('pollutionExpiry')?.value),
    taxExpiry: pick(document.getElementById('taxExpiry')?.value),
    insuranceExpiry: pick(document.getElementById('insuranceExpiry')?.value),
    ownership: pick(document.getElementById('ownership')?.value),
  };
}

// ====== Build payload from current form ======
function buildAdvisorInput(){
  const category    = pick(document.getElementById('category')?.value);
  const subCategory = pick(document.getElementById('subCategory')?.value);
  const state       = pick(document.getElementById('state')?.value);
  const city        = pick(document.getElementById('city')?.value);
  const price       = num(pick(document.getElementById('price')?.value), 0);

  const selectedCategoryHasBrands = !!(brands && brands[category]);
  const brand = selectedCategoryHasBrands
    ? pick(document.getElementById('brandDropdown')?.value)
    : pick(document.getElementById('brandText')?.value);

  const model = pick(document.getElementById('modelText')?.value);
  const title = pick(document.getElementById('title')?.value);

  const meta = extractMetaFromDescription();
  const veh  = readVehicleFields();

  // If user didn’t type age in description but selected Year of Purchase, derive approx age
  if (!meta.age && veh.yearOfPurchase) {
    const y = Number(veh.yearOfPurchase);
    if (Number.isFinite(y)) {
      const nowY = new Date().getFullYear();
      const years = Math.max(0, nowY - y);
      meta.age = years === 0 ? 'less than 1 year' : (years + ' years');
    }
  }

  return {
    brand, model, category, subCategory, title,
    desc: meta.desc,
    state, city,
    condition: meta.condition,
    billBox: meta.billBox,
    age: meta.age,
    price,

    // Vehicle extras (sent to API; your function accepts kmDriven already; others help the model & local adjuster)
    kmDriven: veh.kmDriven,
    yearOfPurchase: veh.yearOfPurchase,
    tyreCondition: veh.tyreCondition,
    accidentStatus: veh.accidentStatus,
    allPapersAvailable: veh.allPapersAvailable,
    pollutionExpiry: veh.pollutionExpiry,
    taxExpiry: veh.taxExpiry,
    insuranceExpiry: veh.insuranceExpiry,
    ownership: veh.ownership
  };
}

// ====== Local adjuster: apply vehicle extras to the returned band (UI only) ======
// Goal: give instant, practical effect even if backend can’t fully price each factor.
function adjustBandForVehicleExtras(input, band){
  if (!isAIEligible(input.category)) return band;

  // Base multiplier
  let mul = 1.0;

  // Ownership penalty
  const own = (input.ownership || '').toLowerCase();
  if (own.startsWith('second')) mul *= 0.97;
  else if (own.startsWith('third')) mul *= 0.94;
  else if (own.startsWith('fourth')) mul *= 0.90;

  // Accident status
  const acc = (input.accidentStatus || '').toLowerCase();
  if (acc.includes('minor')) mul *= 0.95;
  else if (acc.includes('major')) mul *= 0.88;

  // Tyres
  const tyre = (input.tyreCondition || '').toLowerCase();
  if (tyre === 'new') mul *= 1.01;
  else if (tyre === 'average') mul *= 0.98;
  else if (tyre === 'worn out') mul *= 0.96;

  // Papers
  if (String(input.allPapersAvailable || '').toLowerCase() === 'no') mul *= 0.92;

  // Expiries
  if (String(input.pollutionExpiry||'').toLowerCase()==='expired')  mul *= 0.98;
  if (String(input.taxExpiry||'').toLowerCase()==='expired')        mul *= 0.98;
  if (String(input.insuranceExpiry||'').toLowerCase()==='expired')  mul *= 0.97;

  // KM Driven effect (different bands for cars vs bikes)
  const km = num(input.kmDriven, 0);
  if (km > 0) {
    if (input.category === 'Cars') {
      if (km > 150000) mul *= 0.90;
      else if (km > 100000) mul *= 0.93;
      else if (km > 60000) mul *= 0.96;
      else if (km > 30000) mul *= 0.98;
    } else if (input.category === 'Bikes') {
      if (km > 80000) mul *= 0.90;
      else if (km > 50000) mul *= 0.93;
      else if (km > 30000) mul *= 0.96;
      else if (km > 15000) mul *= 0.98;
    }
  }

  // Clamp multiplier
  mul = Math.max(0.75, Math.min(1.08, mul));

  // Apply
  const adj = (n)=> Math.round(num(n)*mul);
  return {
    low: adj(band.low),
    high: adj(band.high),
    suggest: adj(band.suggest),
    quick: adj(band.quick || band.low),
    patience: adj(band.patience || band.high),
    _multiplier: mul
  };
}

// ====== Call function ======
async function callPriceAdvisor(input, {signal}={}){
  const r = await fetch(PRICE_ADVISOR_URL, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body: JSON.stringify({ input }),
    signal
  });
  if(!r.ok){
    const t = await r.text().catch(()=> '');
    throw new Error(`Advisor ${r.status}: ${t.slice(0,300)}`);
  }
  return r.json();
}

// ====== Render results ======
function renderAdvisorUI({input, data}){
  const box = document.getElementById('advisorBox');
  const res = document.getElementById('advisorResult');
  const err = document.getElementById('advisorError');
  const load= document.getElementById('advisorLoading');
  const body= document.getElementById('advisorBody');
  const badges = document.getElementById('advisorBadges');
  const verdict = document.getElementById('advisorVerdict');

  box.hidden = false;
  load.hidden = true;
  err.hidden = true;
  res.hidden = false;

  // Apply local vehicle adjustments for Cars/Bikes (Mobiles unchanged)
  const baseBand = data.band || {};
  const tunedBand = adjustBandForVehicleExtras(input, baseBand);
  const refs = data.refs || {};

  // Verdict (compare user price vs tuned band)
  const p = num(input.price,0), L = num(tunedBand.low,0), H = num(tunedBand.high,0);
  let klass = 'v-fair', verdictTxt = 'Fair Price';
  if(p>0 && H>0 && p>H){
    const pct = Math.round(((p-H)/Math.max(1,H))*100);
    verdictTxt = `Overpriced by ~${pct}%`; klass='v-over';
  } else if(p>0 && L>0 && p<L){
    const pct = Math.round(((L-p)/Math.max(1,L))*100);
    verdictTxt = `Bargain (~${pct}% under)`; klass='v-deal';
  }
  verdict.className = 'advisor-verdict '+klass;
  verdict.innerHTML = `<i class="fas fa-balance-scale"></i> ${verdictTxt}`;

  // Body (search-like brief)
  const brandModel = [input.brand, input.model].filter(Boolean).join(' ');
  const ageText = input.age ? (', '+input.age) : '';
  const condText = input.condition ? (', '+input.condition.toLowerCase()) : '';
  const locText = [input.city, input.state].filter(Boolean).join(', ');

  // Compose a compact line with key vehicle extras (only for Cars/Bikes)
  let extrasLine = '';
  if (isAIEligible(input.category) && input.category !== 'Mobiles') {
    const bits = [];
    if (input.kmDriven) bits.push(`${num(input.kmDriven)} km`);
    if (input.ownership) bits.push(input.ownership);
    if (input.tyreCondition) bits.push(`Tyres: ${input.tyreCondition}`);
    if (input.accidentStatus) bits.push(`Accident: ${input.accidentStatus}`);
    if (String(input.allPapersAvailable||'').toLowerCase()==='no') bits.push('Missing papers');
    const expBits = [];
    if (String(input.insuranceExpiry||'').toLowerCase()==='expired') expBits.push('Insurance expired');
    if (String(input.taxExpiry||'').toLowerCase()==='expired') expBits.push('Tax expired');
    if (String(input.pollutionExpiry||'').toLowerCase()==='expired') expBits.push('PUC expired');
    extrasLine = [...bits, ...expBits].join(' • ');
  }

  const line1 = `<b>${brandModel || (input.category||'Item')}</b>${ageText}${condText} — ${locText || 'India'}${extrasLine ? ' • ' + extrasLine : ''}.`;
  const line2 = `Expected market band: <b>${rupees(tunedBand.low)} – ${rupees(tunedBand.high)}</b>. Suggested: <b>${rupees(tunedBand.suggest)}</b>.`;
  const line3 = `Quick-sale aim: <b>${rupees(tunedBand.quick)}</b>, With patience: <b>${rupees(tunedBand.patience)}</b>.`;
  const line4 = `<span style="color:#555">Refs:</span> ${refs.launch ? `<i>${refs.launch}</i>` : ''} ${refs.used ? `• <i>${refs.used}</i>` : ''}`;

  body.innerHTML = `${line1}<br>${line2}<br>${line3}<br>${line4}`;

  // Badges
  badges.innerHTML = '';
  const chips = [
    {icon:'fa-indian-rupee-sign', text:`Your price: ${rupees(p)}`},
    {icon:'fa-tag', text:`Suggested: ${rupees(tunedBand.suggest)}`},
    {icon:'fa-bolt', text:`Quick: ${rupees(tunedBand.quick)}`},
    {icon:'fa-hourglass-half', text:`Patience: ${rupees(tunedBand.patience)}`}
  ];
  if (tunedBand._multiplier && tunedBand._multiplier !== 1) {
    const pct = Math.round((tunedBand._multiplier - 1)*100);
    chips.push({icon:'fa-sliders-h', text:`Vehicle factors: ${pct>=0? '+'+pct : pct}%`});
  }
  chips.forEach(c=>{
    const span=document.createElement('span');
    span.className='badge';
    span.innerHTML=`<i class="fas ${c.icon}"></i> ${c.text}`;
    badges.appendChild(span);
  });
}

function showAdvisorLoading(){
  const box = document.getElementById('advisorBox');
  box.hidden = false;
  document.getElementById('advisorResult').hidden = true;
  document.getElementById('advisorError').hidden = true;
  const load= document.getElementById('advisorLoading');
  load.hidden = false;
}
function showAdvisorError(msg){
  const box = document.getElementById('advisorBox');
  box.hidden = false;
  document.getElementById('advisorResult').hidden = true;
  const e = document.getElementById('advisorError');
  e.hidden = false;
  e.textContent = msg;
  document.getElementById('advisorLoading').hidden = true;
}

// ====== Orchestrator ======
async function runAdvisor(){
  try{
    const catVal = document.getElementById('category')?.value || '';
    if(!isAIEligible(catVal)){ toggleAdvisorForCategory(); return; }

    const input = buildAdvisorInput();

    // minimal guards
    if(!input.category || !input.brand || !input.state || !input.city || !input.price){
      showAdvisorError('Fill Category, Brand, Location and Price first.');
      return;
    }

    showAdvisorLoading();
    const data = await callPriceAdvisor(input);
    const bandOk = data && data.band && num(data.band.low)>0 && num(data.band.high)>0;
    if(!bandOk){ showAdvisorError('Could not compute price band. Try again.'); return; }

    renderAdvisorUI({input, data});
  }catch(e){
    showAdvisorError(String(e.message||e));
  }
}

// ====== Hooks ======
(function setupAdvisorUI(){
  const box = document.getElementById('advisorBox');
  if(!box) return;

  // Start hidden unless eligible
  toggleAdvisorForCategory();

  // Button
  document.getElementById('advisorRunBtn')?.addEventListener('click', runAdvisor);

  // Auto-trigger when user edits price (debounced)
  const priceEl = document.getElementById('price');
  let t=null;
  priceEl?.addEventListener('input', ()=>{
    clearTimeout(t); t=setTimeout(()=>{ if(priceEl.value.trim()) runAdvisor(); }, 600);
  });

  // Re-run on relevant field changes
  ['brandDropdown','brandText','modelText','state','city','subCategory'].forEach(id=>{
    const el=document.getElementById(id);
    if(!el) return;
    el.addEventListener('change', ()=>{ clearTimeout(t); t=setTimeout(runAdvisor, 400); });
  });

  // Important: category change toggles visibility + (maybe) run
  document.getElementById('category')?.addEventListener('change', ()=>{
    toggleAdvisorForCategory();
    clearTimeout(t);
    t=setTimeout(runAdvisor, 200);
  });

  // Vehicle fields change → re-run
  ['kmDriven','yearOfPurchase','tyreCondition','accidentStatus','allPapersAvailable',
   'pollutionExpiry','taxExpiry','insuranceExpiry','ownership'].forEach(id=>{
    const el=document.getElementById(id);
    if(!el) return;
    el.addEventListener('change', ()=>{ clearTimeout(t); t=setTimeout(runAdvisor, 400); });
    el.addEventListener('input',  ()=>{ clearTimeout(t); t=setTimeout(runAdvisor, 500); });
  });
})();
</script>
