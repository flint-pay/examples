const secrets = /(?:flint_(?:test|live|cses|cref)_[A-Za-z0-9_-]+|ck(?:at|lt)_[A-Za-z0-9_-]+|whsec_[A-Za-z0-9+/=_-]+|[A-Za-z0-9_-]*_secret_[A-Za-z0-9_-]+|\b\d{6}\b)/g;
export function redact(value:string):string{return value.replace(secrets,'[redacted]');}
export function logRequest(entry:{request_id:string;route:string;status:number;duration_ms:number;flint_request_id?:string}) {
  console.info(JSON.stringify({...entry,route:redact(entry.route)}));
}
