// stateLock.js - State management with proper locking mechanisms

export class StateLock {
  constructor(logger) {
    this.logger = logger;
    this.memoryLocks = new Map();
    this.lockPrefix = 'lock_';
    this.statePrefix = 'state_';
  }

  // Generate lock key
  getLockKey(resource) {
    return `${this.lockPrefix}${resource}`;
  }

  // Generate state key
  getStateKey(resource) {
    return `${this.statePrefix}${resource}`;
  }

  // Acquire lock with timeout
  async acquireLock(resource, timeout = 5000) {
    const lockKey = this.getLockKey(resource);
    const lockId = `${Date.now()}-${Math.random()}`;
    const startTime = Date.now();

    this.logger.debug('acquireLock: attempting', { resource, lockId });

    // Check memory lock first (fast path)
    if (this.memoryLocks.has(resource)) {
      const existingLock = this.memoryLocks.get(resource);
      const age = Date.now() - existingLock.timestamp;
      
      if (age < timeout) {
        this.logger.debug('acquireLock: blocked by memory lock', {
          resource,
          lockId,
          existingLockId: existingLock.id,
          age
        });
        return null;
      } else {
        this.logger.warn('acquireLock: clearing stale memory lock', {
          resource,
          lockId,
          staleLockId: existingLock.id,
          age
        });
        this.memoryLocks.delete(resource);
      }
    }

    // Set memory lock
    this.memoryLocks.set(resource, {
      id: lockId,
      timestamp: Date.now()
    });

    try {
      // Check storage lock
      const storageLock = await chrome.storage.local.get(lockKey);
      
      if (storageLock[lockKey]) {
        const lockData = storageLock[lockKey];
        const age = Date.now() - lockData.timestamp;
        
        if (age < timeout) {
          // Lock is held by another instance
          this.logger.debug('acquireLock: blocked by storage lock', {
            resource,
            lockId,
            existingLockId: lockData.id,
            age
          });
          
          // Remove our memory lock
          this.memoryLocks.delete(resource);
          return null;
        } else {
          this.logger.warn('acquireLock: clearing stale storage lock', {
            resource,
            lockId,
            staleLockId: lockData.id,
            age
          });
        }
      }

      // Set storage lock
      await chrome.storage.local.set({
        [lockKey]: {
          id: lockId,
          timestamp: Date.now()
        }
      });

      this.logger.info('acquireLock: acquired', {
        resource,
        lockId,
        duration: Date.now() - startTime
      });

      return lockId;

    } catch (error) {
      // Clean up memory lock on error
      this.memoryLocks.delete(resource);
      this.logger.error('acquireLock: error', {
        resource,
        lockId,
        error: error.message
      });
      throw error;
    }
  }

  // Release lock
  async releaseLock(resource, lockId) {
    const lockKey = this.getLockKey(resource);
    const startTime = Date.now();

    this.logger.debug('releaseLock: attempting', { resource, lockId });

    // Remove memory lock
    const memoryLock = this.memoryLocks.get(resource);
    if (memoryLock && memoryLock.id === lockId) {
      this.memoryLocks.delete(resource);
    }

    try {
      // Check storage lock ownership
      const storageLock = await chrome.storage.local.get(lockKey);
      
      if (storageLock[lockKey] && storageLock[lockKey].id === lockId) {
        // We own this lock, remove it
        await chrome.storage.local.remove(lockKey);
        
        this.logger.info('releaseLock: released', {
          resource,
          lockId,
          duration: Date.now() - startTime
        });
        return true;
      } else {
        this.logger.warn('releaseLock: not owner', {
          resource,
          lockId,
          actualLock: storageLock[lockKey]
        });
        return false;
      }

    } catch (error) {
      this.logger.error('releaseLock: error', {
        resource,
        lockId,
        error: error.message
      });
      throw error;
    }
  }

  // Try to acquire lock with retries
  async tryAcquireLock(resource, maxRetries = 3, retryDelay = 100) {
    for (let i = 0; i < maxRetries; i++) {
      const lockId = await this.acquireLock(resource);
      if (lockId) {
        return lockId;
      }

      if (i < maxRetries - 1) {
        this.logger.debug('tryAcquireLock: retrying', {
          resource,
          attempt: i + 1,
          maxRetries
        });
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    this.logger.warn('tryAcquireLock: failed after retries', {
      message: 'Failed to acquire lock after all retries',
      resource,
      maxRetries,
      action: 'LOCK_FAILED'
    });
    return null;
  }

  // Execute function with lock
  async withLock(resource, fn, timeout = 5000) {
    const lockId = await this.acquireLock(resource, timeout);
    
    if (!lockId) {
      throw new Error(`Failed to acquire lock for resource: ${resource}`);
    }

    try {
      this.logger.debug('withLock: executing function', { resource, lockId });
      const result = await fn();
      return result;
    } finally {
      await this.releaseLock(resource, lockId);
    }
  }

  // State management with locking
  async getState(resource) {
    const stateKey = this.getStateKey(resource);
    const state = await chrome.storage.local.get(stateKey);
    return state[stateKey] || null;
  }

  async setState(resource, value) {
    const stateKey = this.getStateKey(resource);
    await chrome.storage.local.set({ [stateKey]: value });
  }

  async clearState(resource) {
    const stateKey = this.getStateKey(resource);
    await chrome.storage.local.remove(stateKey);
  }

  // Atomic state update with locking
  async updateState(resource, updateFn) {
    return this.withLock(resource, async () => {
      const currentState = await this.getState(resource);
      const newState = await updateFn(currentState);
      if (newState !== undefined) {
        await this.setState(resource, newState);
      }
      return newState;
    });
  }

  // Clear all locks (for testing/cleanup)
  async clearAllLocks() {
    this.logger.warn('clearAllLocks: clearing all locks');
    
    // Clear memory locks
    this.memoryLocks.clear();
    
    // Clear storage locks
    const allKeys = await chrome.storage.local.get();
    const lockKeys = Object.keys(allKeys).filter(key => key.startsWith(this.lockPrefix));
    
    if (lockKeys.length > 0) {
      await chrome.storage.local.remove(lockKeys);
      this.logger.warn('clearAllLocks: removed storage locks', { count: lockKeys.length });
    }
  }
  
  // Check if lock is active
  async isLockActive(resource, timeout = 30000) {
    const lockKey = this.getLockKey(resource);
    
    // Check memory first
    const memoryLock = this.memoryLocks.get(resource);
    if (memoryLock) {
      const age = Date.now() - memoryLock.timestamp;
      if (age < timeout) {
        this.logger.debug('Lock active in memory', { resource, age, timeout });
        return true;
      }
    }
    
    // Check storage
    const result = await chrome.storage.local.get(lockKey);
    const storageLock = result[lockKey];
    
    if (!storageLock) {
      this.logger.debug('No lock found', { resource });
      return false;
    }
    
    const age = Date.now() - storageLock.timestamp;
    const isActive = age < timeout;
    
    this.logger.debug('Storage lock check', { 
      resource, 
      age, 
      timeout,
      isActive,
      lockId: storageLock.id 
    });
    
    return isActive;
  }

  // Get lock status (for debugging)
  async getLockStatus() {
    const allKeys = await chrome.storage.local.get();
    const lockKeys = Object.keys(allKeys).filter(key => key.startsWith(this.lockPrefix));
    
    const locks = {};
    for (const key of lockKeys) {
      const resource = key.substring(this.lockPrefix.length);
      locks[resource] = {
        storage: allKeys[key],
        memory: this.memoryLocks.get(resource) || null
      };
    }
    
    return locks;
  }
}

// Export singleton instance
export default StateLock;