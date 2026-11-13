export interface ConversationSendClaim {
  release(): void;
}

export interface ConversationSendLease {
  tryAcquire(key: string): ConversationSendClaim | null;
  isClaimed(key: string): boolean;
}

export function createConversationSendLease(): ConversationSendLease {
  const claims = new Map<string, symbol>();

  return {
    tryAcquire(key) {
      if (claims.has(key)) return null;
      const token = Symbol(key);
      claims.set(key, token);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          if (claims.get(key) === token) claims.delete(key);
        },
      };
    },
    isClaimed(key) {
      return claims.has(key);
    },
  };
}
