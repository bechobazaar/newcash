exports.handler = async (event, context) => {
  const headers = event.headers || {};
  const xff = (headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '').split(',')[0].trim();
  const ccip = headers['x-nf-client-connection-ip'] || headers['X-NF-Client-Connection-IP'] || '';
  const raw = xff || ccip || '';

  const ipv4Match = raw.match(/(\d{1,3}\.){3}\d{1,3}/); // picks 103.x.x.x inside ::ffff:103.x.x.x also
  const ipv4 = ipv4Match ? ipv4Match[0] : null;

  // crude ipv6 detect (hex + colons)
  const looksIPv6 = /:/.test(raw) && !ipv4;
  const ipv6 = looksIPv6 ? raw : null;

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ ipv4, ipv6, raw })
  };
};
