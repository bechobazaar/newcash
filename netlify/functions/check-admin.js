// Netlify function absolute URL (क्योंकि frontend ThePowerHost पर है)
const FN_BASE = 'https://bechobazaar.netlify.app/.netlify/functions';

firebase.auth().onAuthStateChanged(async (user)=>{
  try{
    if(!user){ blockUI(); return; }

    // 1) ताज़ा token लो और debug log करो
    const token = await user.getIdToken(true);
    console.log('idToken len=', token?.length, 'prefix=', token?.slice?.(0,12));

    // 2) server verify (Authorization header के साथ)
    const res = await fetch(`${FN_BASE}/check-admin`, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token }
    });

    if (res.ok) {
      allowUI();
    } else {
      const txt = await res.text();           // 👈 debug मदद करेगा
      console.warn('check-admin failed:', res.status, txt);
      await firebase.auth().signOut();
      blockUI(); clearMsg();
      showMsg("This Email ID is not registered as Admin.", false);
    }
  }catch(err){
    console.error('verify error', err);
    await firebase.auth().signOut();
    blockUI(); clearMsg();
    showMsg("Verification error. Try again.", false);
  }
});
