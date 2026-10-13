export class RateLimiter {
  private buckets = new Map<string,{count:number;until:number}>();
  take(key:string, count:number, windowMs:number): boolean {
    const now=Date.now();
    let bucket=this.buckets.get(key);
    if (!bucket || bucket.until<=now) {
      if(this.buckets.size>=10000){for(const [id,item] of this.buckets)if(item.until<=now)this.buckets.delete(id);if(!this.buckets.has(key)&&this.buckets.size>=10000)return false;}
      bucket={count:0,until:now+windowMs};this.buckets.set(key,bucket);
    }
    if(bucket.count>=count)return false;
    bucket.count++;return true;
  }
}
