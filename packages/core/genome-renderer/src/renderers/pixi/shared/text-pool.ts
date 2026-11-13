import { Container, Text, TextStyle } from 'pixi.js';
import { destroyPixiText } from './pixi-text-lifecycle';

export class TextPool {
  private pool: Text[] = [];
  private index = 0;
  private container: Container;
  private style: TextStyle;

  constructor(parent: Container, style: TextStyle) {
    this.container = new Container();
    this.style = style;
    parent.addChild(this.container);
  }

  reset(): void {
    for (let i = 0; i < this.index; i++) {
      this.pool[i].visible = false;
    }
    this.index = 0;
  }

  acquire(): Text {
    if (this.index < this.pool.length) {
      const t = this.pool[this.index++];
      t.visible = true;
      t.scale.set(1);
      t.rotation = 0;
      if (t.style !== this.style) t.style = this.style;
      return t;
    }
    const t = new Text({ text: '', style: this.style });
    this.container.addChild(t);
    this.pool.push(t);
    this.index++;
    return t;
  }

  setStyle(style: TextStyle): void {
    if (this.style === style) return;
    this.style = style;
    for (const t of this.pool) {
      if (t.style !== style) t.style = style;
    }
  }

  get activeCount(): number {
    return this.index;
  }

  destroy(): void {
    for (const t of this.pool) destroyPixiText(t);
    this.container.destroy();
  }
}

export class KeyedTextPool {
  private readonly pool = new Map<string, Text>();
  private readonly active = new Set<string>();
  private readonly container: Container;

  constructor(
    parent: Container,
    private style: TextStyle,
    private readonly maxRetained = 32
  ) {
    if (!Number.isSafeInteger(maxRetained) || maxRetained < 1) {
      throw new Error('KeyedTextPool maxRetained must be a positive integer');
    }
    this.container = new Container();
    parent.addChild(this.container);
  }

  reset(): void {
    for (const key of this.active) {
      const text = this.pool.get(key);
      if (text) text.visible = false;
    }
    this.active.clear();
  }

  acquire(textValue: string): Text {
    let text = this.pool.get(textValue);
    if (!text) {
      text = new Text({ text: textValue, style: this.style });
      this.container.addChild(text);
      this.pool.set(textValue, text);
    }
    text.visible = true;
    text.scale.set(1);
    text.rotation = 0;
    if (text.style !== this.style) text.style = this.style;
    this.active.add(textValue);
    return text;
  }

  trimInactive(): void {
    if (this.pool.size <= this.maxRetained) return;
    for (const [key, text] of this.pool) {
      if (this.pool.size <= this.maxRetained) break;
      if (this.active.has(key)) continue;
      this.pool.delete(key);
      destroyPixiText(text);
    }
  }

  setStyle(style: TextStyle): void {
    if (this.style === style) return;
    this.style = style;
    for (const text of this.pool.values()) {
      if (text.style !== style) text.style = style;
    }
  }

  get retainedCount(): number {
    return this.pool.size;
  }

  destroy(): void {
    for (const text of this.pool.values()) destroyPixiText(text);
    this.pool.clear();
    this.active.clear();
    this.container.destroy();
  }
}
