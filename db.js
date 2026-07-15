// =========================================================================
//  Firestore 雲端同步（不需登入、自動儲存、跨裝置即時同步）
//  只同步「單字卡片」；API 金鑰不上雲，留在各裝置的瀏覽器。
// =========================================================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot,
  writeBatch, getDocs,
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyD9mwoyTf1cAS7LTnVMy5lnfFEYW5mYBoY',
  authDomain: 'english-32702.firebaseapp.com',
  projectId: 'english-32702',
  storageBucket: 'english-32702.firebasestorage.app',
  messagingSenderId: '310094543091',
  appId: '1:310094543091:web:973e854f2bf9090624df86',
  measurementId: 'G-MF2FBXC1P3',
};

// 所有卡片存在此集合（不需登入，靠 Firestore 規則允許讀寫）
const COLLECTION = 'cards';

let db;
try {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
} catch (e) {
  console.error('Firebase 初始化失敗', e);
}

const cardsCol = () => collection(db, COLLECTION);

window.Cloud = {
  enabled: !!db,

  // 訂閱雲端卡片變動；每次變動都會呼叫 onCards(array)
  start(onCards) {
    if (!db) return () => {};
    return onSnapshot(cardsCol(),
      snap => {
        const arr = [];
        snap.forEach(d => arr.push(d.data()));
        onCards(arr);
      },
      err => console.error('Firestore 訂閱錯誤', err)
    );
  },

  async upsert(card) {
    if (!db || !card || !card.id) return;
    try { await setDoc(doc(db, COLLECTION, card.id), card); }
    catch (e) { console.error('雲端寫入失敗', e); }
  },

  async remove(id) {
    if (!db || !id) return;
    try { await deleteDoc(doc(db, COLLECTION, id)); }
    catch (e) { console.error('雲端刪除失敗', e); }
  },

  // 批次寫入（匯入、首次同步用）；Firestore 單批上限 500
  async bulk(cardArr) {
    if (!db || !cardArr || !cardArr.length) return;
    try {
      for (let i = 0; i < cardArr.length; i += 400) {
        const batch = writeBatch(db);
        cardArr.slice(i, i + 400).forEach(c => {
          if (c && c.id) batch.set(doc(db, COLLECTION, c.id), c);
        });
        await batch.commit();
      }
    } catch (e) { console.error('雲端批次寫入失敗', e); }
  },

  async clearAll() {
    if (!db) return;
    try {
      const snap = await getDocs(cardsCol());
      const docs = [];
      snap.forEach(d => docs.push(d.id));
      for (let i = 0; i < docs.length; i += 400) {
        const batch = writeBatch(db);
        docs.slice(i, i + 400).forEach(id => batch.delete(doc(db, COLLECTION, id)));
        await batch.commit();
      }
    } catch (e) { console.error('雲端清空失敗', e); }
  },
};

// 通知 app.js 雲端已就緒
window.dispatchEvent(new Event('cloud-ready'));
