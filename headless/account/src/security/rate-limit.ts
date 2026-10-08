export class RateLimiter {
  private buckets=new Map<string,{count:number;until:number}>();
  take(key:string,count:number,windowMs:number):boolean {
    const now=Date.now();
    for(const [id,bucket] of this.buckets)if(bucket.until<=now)this.buckets.delete(id);
    let bucket=this.buckets.get(key);
    if(!bucket){if(this.buckets.size>=10000)return false;bucket={count:0,until:now+windowMs};this.buckets.set(key,bucket);}
    if(bucket.count>=count)return false;
    bucket.count++;return true;
  }
}
