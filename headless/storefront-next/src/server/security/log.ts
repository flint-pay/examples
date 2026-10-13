const secrets = /(?:flint_(?:test|live|cses|cref)_[A-Za-z0-9_-]+|ck(?:at|lt)_[A-Za-z0-9_-]+|whsec_[A-Za-z0-9+/=_-]+|gccp_[A-Za-z0-9_-]+|gccf_[A-Za-z0-9_.-]+|\/gift-card-challenge\/[^\s"?#]+|[A-Za-z0-9_-]*_secret_[A-Za-z0-9_-]+|\b\d{6}\b)/g;
export function redact(value:string):string{return value.replace(secrets,'[redacted]');}
export function logRequest(entry:{request_id:string;route:string;status:number;duration_ms:number;flint_request_id?:string}) {
  console.info(JSON.stringify({...entry,route:redact(entry.route)}));
}

export function logGiftChallenge(entry:{outcome:'issued'|'origin_required'|'unavailable'|'retry_applied'|'retry_rejected'|'retry_unknown';cause?:string;checkout_ref:string;flint_request_id?:string}){
  console.info(JSON.stringify({event:'gift_challenge',...entry}));
}
export function logLaunchInvalid(cause:'page_origin_mismatch'|'invalid_page_origin',flint_request_id?:string){console.warn(JSON.stringify({event:'checkout_launch_invalid',cause,flint_request_id}));}
