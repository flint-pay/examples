import type {Client,Product,ProductVariant,SubscriptionPlan} from '@flintpay/node';
import type {Auth} from './auth.ts';
import {LocalError} from './errors.ts';
export type CatalogItem={slug:string;product:Product;variants:ProductVariant[]};
export type CatalogPlan={slug:string;plan:SubscriptionPlan};
export class Catalog {
  client:Client;auth:Auth;private cache?:{until:number;products:CatalogItem[];plans:CatalogPlan[]};
  constructor(client:Client,auth:Auth){this.client=client;this.auth=auth;}
  async read(force=false):Promise<{products:CatalogItem[];plans:CatalogPlan[]}>{
    if(!force&&this.cache&&this.cache.until>Date.now())return this.cache;
    const products:CatalogItem[]=[];const plans:CatalogPlan[]=[];
    for await(const product of this.client.products.listItems({status:'active',page_size:100},this.auth.merchant())){
      if(product.metadata?.example_catalog!=='cedar-and-stone'||!product.metadata.example_slug)continue;
      const variants:ProductVariant[]=[];
      for await(const variant of this.client.products.listVariantsItems(product.product_id,{status:'active',page_size:100},this.auth.merchant()))variants.push(variant);
      products.push({slug:product.metadata.example_slug,product,variants});
    }
    for await(const plan of this.client.subscriptionPlans.listItems({status:'active',page_size:100},this.auth.merchant()))if(plan.metadata?.example_catalog==='cedar-and-stone'&&plan.metadata.example_slug)plans.push({slug:plan.metadata.example_slug,plan});
    this.cache={products,plans,until:Date.now()+60_000};return this.cache;
  }
  async product(slug:string):Promise<CatalogItem>{const item=(await this.read()).products.find(item=>item.slug===slug);if(!item)throw new LocalError('NOT_FOUND',404);return item;}
  async plan(slug:string):Promise<CatalogPlan>{const item=(await this.read()).plans.find(item=>item.slug===slug);if(!item)throw new LocalError('NOT_FOUND',404);return item;}
}
