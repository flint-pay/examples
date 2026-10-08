export function logRequest(entry:{request_id:string;route:string;status:number;duration_ms:number}) {console.info(JSON.stringify(entry));}
// Callers log route templates and safe error codes only. Bodies, queries, headers, URLs, and upstream messages are excluded.
