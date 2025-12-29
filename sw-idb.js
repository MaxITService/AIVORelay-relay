'use strict';

const IDB_NAME = 'aivo-relay';
const IDB_VERSION = 1;
const STORE_BLOBS = 'blobs';

let idbInstance = null;

async function openBlobDb() {
  if (idbInstance) return idbInstance;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: 'key' });
      }
    };

    request.onsuccess = (event) => {
      idbInstance = event.target.result;
      idbInstance.onclose = () => { idbInstance = null; };
      resolve(idbInstance);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

function buildBlobKey(messageId, attId) {
  return `${messageId}:${attId}`;
}

async function storeBlob(messageId, attId, bytes) {
  if (!messageId || !attId || !bytes) return;
  const db = await openBlobDb();
  const key = buildBlobKey(messageId, attId);
  const record = {
    key,
    messageId,
    attId,
    bytes,
    storedAt: Date.now()
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, 'readwrite');
    const store = tx.objectStore(STORE_BLOBS);
    const request = store.put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getBlob(messageId, attId) {
  if (!messageId || !attId) return null;
  const db = await openBlobDb();
  const key = buildBlobKey(messageId, attId);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, 'readonly');
    const store = tx.objectStore(STORE_BLOBS);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function deleteBlob(messageId, attId) {
  if (!messageId || !attId) return;
  const db = await openBlobDb();
  const key = buildBlobKey(messageId, attId);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, 'readwrite');
    const store = tx.objectStore(STORE_BLOBS);
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function deleteBlobsForMessage(messageId) {
  if (!messageId) return;
  const db = await openBlobDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, 'readwrite');
    const store = tx.objectStore(STORE_BLOBS);
    const request = store.openCursor();
    const toDelete = [];

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value.messageId === messageId) {
          toDelete.push(cursor.value.key);
        }
        cursor.continue();
      } else {
        for (const key of toDelete) {
          store.delete(key);
        }
        resolve(toDelete.length);
      }
    };

    request.onerror = () => reject(request.error);
  });
}

async function getAllBlobKeys() {
  const db = await openBlobDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, 'readonly');
    const store = tx.objectStore(STORE_BLOBS);
    const request = store.getAllKeys();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function cleanupOrphanedBlobs(validMessageIds) {
  const validSet = new Set(validMessageIds);
  const db = await openBlobDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, 'readwrite');
    const store = tx.objectStore(STORE_BLOBS);
    const request = store.openCursor();
    let deletedCount = 0;

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        if (!validSet.has(cursor.value.messageId)) {
          cursor.delete();
          deletedCount += 1;
        }
        cursor.continue();
      } else {
        resolve(deletedCount);
      }
    };

    request.onerror = () => reject(request.error);
  });
}
