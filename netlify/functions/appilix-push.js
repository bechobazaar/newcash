// POST /.netlify/functions/appilix-push
// Body: { user_identity, title, body, open_link_url? }
export default async (req) => {
  try{
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ ok:false, error:'Method not allowed' }), { status:405 });
    }
    const { user_identity, title, body, open_link_url } = await req.json();
    if(!user_identity || !title || !body){
      return new Response(JSON.stringify({ ok:false, error:'Missing fields' }), { status:400 });
    }

    const APP_KEY = process.env.APPILIX_APP_KEY;
    const API_KEY = process.env.APPILIX_API_KEY;
    if(!APP_KEY || !API_KEY){
      return new Response(JSON.stringify({ ok:false, error:'Server not configured' }), { status:500 });
    }

    const form = new URLSearchParams();
    form.set('app_key', APP_KEY);
    form.set('api_key', API_KEY);
    form.set('notification_title', title);
    form.set('notification_body', body);
    form.set('user_identity', user_identity);
    if (open_link_url) form.set('open_link_url', open_link_url);

    const r = await fetch('https://appilix.com/api/push-notification', {
      method:'POST',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const text = await r.text();
    if(!r.ok) return new Response(JSON.stringify({ ok:false, status:r.status, body:text }), { status:502 });
    return new Response(JSON.stringify({ ok:true, body:text }), { status:200 });
  }catch(err){
    return new Response(JSON.stringify({ ok:false, error:String(err) }), { status:500 });
  }
};
