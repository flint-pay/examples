import {Store} from './db.ts';
import type {Session,User} from '../identity/index.ts';
import {randomReference} from '../identity/index.ts';
import {LocalError} from '../flint/errors.ts';
import type {Catalog} from '../flint/catalog.ts';
export type Cart={cart_id:string;session_hash:string;user_id:string|null;status:string;merged_into:string|null;created_at:number;updated_at:number};
export type CartLine={line_id:string;cart_id:string;product_id:string;variant_id:string;quantity:number};
export class Carts {
  store:Store;catalog:Catalog;
  constructor(store:Store,catalog:Catalog){this.store=store;this.catalog=catalog;}
  current(session:Session,user?:User):Cart {
    let cart=user?this.store.get<Cart>("SELECT * FROM carts WHERE user_id=? AND status='open' ORDER BY updated_at DESC LIMIT 1",user.user_id):this.store.get<Cart>("SELECT * FROM carts WHERE session_hash=? AND user_id IS NULL AND status='open' ORDER BY updated_at DESC LIMIT 1",session.session_hash);
    if(!cart){const id=randomReference('cart_');this.store.run('INSERT INTO carts(cart_id,session_hash,user_id,created_at,updated_at) VALUES(?,?,?,?,?)',id,session.session_hash,user?.user_id??null,Date.now(),Date.now());cart=this.store.get<Cart>('SELECT * FROM carts WHERE cart_id=?',id)!;}
    return cart;
  }
  lines(cart:Cart):CartLine[]{return this.store.all('SELECT * FROM cart_lines WHERE cart_id=? ORDER BY line_id',cart.cart_id);}
  quantity(value:unknown):number{const quantity=Number(value);if(!Number.isInteger(quantity)||quantity<1||quantity>20)throw new LocalError('INVALID_QUANTITY');return quantity;}
  async add(cart:Cart,slug:string,variantId:string,quantity:unknown):Promise<CartLine>{
    const item=await this.catalog.product(slug);const variant=item.variants.find(variant=>variant.variant_id===variantId);
    if(!variant?.available_for_sale)throw new LocalError('PRODUCT_UNAVAILABLE');
    const amount=this.quantity(quantity);const existing=this.lines(cart).find(line=>line.variant_id===variantId);
    if(existing){this.store.run('UPDATE cart_lines SET quantity=? WHERE line_id=?',Math.min(20,existing.quantity+amount),existing.line_id);return {...existing,quantity:Math.min(20,existing.quantity+amount)};}
    const line:CartLine={line_id:randomReference('ln_'),cart_id:cart.cart_id,product_id:item.product.product_id,variant_id:variantId,quantity:amount};
    this.store.run('INSERT INTO cart_lines VALUES(?,?,?,?,?)',line.line_id,line.cart_id,line.product_id,line.variant_id,line.quantity);return line;
  }
  merge(oldSession:Session,user:User){
    this.store.transaction(()=>{
      const anonymous=this.store.get<Cart>("SELECT * FROM carts WHERE session_hash=? AND user_id IS NULL AND status='open'",oldSession.session_hash);
      if(!anonymous)return;
      const target=this.store.get<Cart>("SELECT * FROM carts WHERE user_id=? AND status='open'",user.user_id);
      if(!target){this.store.run('UPDATE carts SET user_id=? WHERE cart_id=?',user.user_id,anonymous.cart_id);return;}
      for(const line of this.lines(anonymous)){
        const existing=this.lines(target).find(item=>item.variant_id===line.variant_id);
        if(existing){this.store.run('UPDATE cart_lines SET quantity=? WHERE line_id=?',Math.min(20,existing.quantity+line.quantity),existing.line_id);this.store.run('DELETE FROM cart_lines WHERE line_id=?',line.line_id);}
        else this.store.run('UPDATE cart_lines SET cart_id=? WHERE line_id=?',target.cart_id,line.line_id);
      }
      this.store.run("UPDATE carts SET status='merged',merged_into=? WHERE cart_id=?",target.cart_id,anonymous.cart_id);
      this.store.run('UPDATE carts SET updated_at=? WHERE cart_id=?',Date.now(),target.cart_id);
      this.store.run("UPDATE checkouts SET cart_dirty=1 WHERE cart_id=? AND status='open'",target.cart_id);
    });
  }
  complete(checkoutRef:string,order:import('@flintpay/node').Order){
    this.store.transaction(()=>{
      const checkout=this.store.get<{cart_id:string|null;cart_finalized:number}>('SELECT cart_id,cart_finalized FROM checkouts WHERE checkout_ref=?',checkoutRef);
      if(!checkout?.cart_id||checkout.cart_finalized)return;
      let cart=this.store.get<Cart>('SELECT * FROM carts WHERE cart_id=?',checkout.cart_id);
      const seen=new Set<string>();
      while(cart?.merged_into&&!seen.has(cart.cart_id)){seen.add(cart.cart_id);cart=this.store.get<Cart>('SELECT * FROM carts WHERE cart_id=?',cart.merged_into);}
      if(!cart)return;
      for(const item of order.line_items){const line=this.lines(cart).find(line=>line.variant_id===item.variant_id);if(!line)continue;const remaining=line.quantity-Number(item.quantity);if(remaining>0)this.store.run('UPDATE cart_lines SET quantity=? WHERE line_id=?',remaining,line.line_id);else this.store.run('DELETE FROM cart_lines WHERE line_id=?',line.line_id);}
      if(!this.lines(cart).length)this.store.run("UPDATE carts SET status='checked_out' WHERE cart_id=?",cart.cart_id);
      this.store.run('UPDATE checkouts SET cart_finalized=1 WHERE checkout_ref=?',checkoutRef);
      this.store.run("UPDATE checkouts SET cart_dirty=1 WHERE cart_id=? AND status='open' AND checkout_ref<>?",cart.cart_id,checkoutRef);
    });
  }
  async view(cart:Cart){
    const catalog=await this.catalog.read();let subtotal=0n;let currency='USD';
    const lines=this.lines(cart).map(line=>{
      const item=catalog.products.find(item=>item.product.product_id===line.product_id);
      const variant=item?.variants.find(variant=>variant.variant_id===line.variant_id);
      if(!item||!variant)throw new LocalError('PRODUCT_UNAVAILABLE',409);
      currency=variant.unit_price_money.currency;subtotal+=BigInt(variant.unit_price_money.amount)*BigInt(line.quantity);
      return {...line,item,variant};
    });
    return {cart_id:cart.cart_id,lines,subtotal_money:{amount:subtotal.toString(),currency}};
  }
}
