import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import type { Cart, Product, Store } from '../store.js';

export const MAX_LINE_QUANTITY = 99;

export interface CartView {
  id: string;
  status: Cart['status'];
  orderId: string | null;
  items: {
    productId: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    lineTotalCents: number;
    inStock: boolean;
  }[];
  itemCount: number;
  subtotalCents: number;
}

export class CartService {
  constructor(private readonly store: Store) {}

  create(): Cart {
    const cart: Cart = {
      id: randomUUID(),
      status: 'OPEN',
      items: new Map(),
      orderId: null,
      createdAt: new Date().toISOString(),
    };
    this.store.carts.set(cart.id, cart);
    return cart;
  }

  get(cartId: string): Cart {
    const cart = this.store.carts.get(cartId);
    if (!cart) throw new AppError(404, 'CART_NOT_FOUND', `Cart ${cartId} not found`);
    return cart;
  }

  addItem(cartId: string, productId: string, quantity: number): Cart {
    const cart = this.openCart(cartId);
    const current = cart.items.get(productId) ?? 0;
    return this.setQuantity(cart, productId, current + quantity);
  }

  updateItem(cartId: string, productId: string, quantity: number): Cart {
    const cart = this.openCart(cartId);
    if (!cart.items.has(productId)) {
      throw new AppError(404, 'ITEM_NOT_IN_CART', `Product ${productId} is not in this cart`);
    }
    return this.setQuantity(cart, productId, quantity);
  }

  removeItem(cartId: string, productId: string): Cart {
    const cart = this.openCart(cartId);
    if (!cart.items.delete(productId)) {
      throw new AppError(404, 'ITEM_NOT_IN_CART', `Product ${productId} is not in this cart`);
    }
    return cart;
  }

  view(cart: Cart): CartView {
    const items = [...cart.items].map(([productId, quantity]) => {
      const product = this.product(productId);
      return {
        productId,
        name: product.name,
        quantity,
        unitPriceCents: product.priceCents,
        lineTotalCents: product.priceCents * quantity,
        inStock: product.stock >= quantity,
      };
    });
    return {
      id: cart.id,
      status: cart.status,
      orderId: cart.orderId,
      items,
      itemCount: items.reduce((n, i) => n + i.quantity, 0),
      subtotalCents: items.reduce((sum, i) => sum + i.lineTotalCents, 0),
    };
  }

  private setQuantity(cart: Cart, productId: string, quantity: number): Cart {
    const product = this.product(productId);
    if (quantity > MAX_LINE_QUANTITY) {
      throw new AppError(400, 'VALIDATION_ERROR', `Quantity per product cannot exceed ${MAX_LINE_QUANTITY}`);
    }
    // Early feedback only. Stock is actually claimed at checkout.
    if (quantity > product.stock) {
      throw new AppError(409, 'INSUFFICIENT_INVENTORY', `Only ${product.stock} of ${product.name} available`, {
        productId,
        requested: quantity,
        available: product.stock,
      });
    }
    cart.items.set(productId, quantity);
    return cart;
  }

  private openCart(cartId: string): Cart {
    const cart = this.get(cartId);
    if (cart.status !== 'OPEN') {
      throw new AppError(409, 'CART_NOT_OPEN', `Cart is ${cart.status.toLowerCase().replace('_', ' ')}`, {
        status: cart.status,
        orderId: cart.orderId,
      });
    }
    return cart;
  }

  private product(productId: string): Product {
    const product = this.store.products.get(productId);
    if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', `Product ${productId} not found`);
    return product;
  }
}
