// =========================================================================
//  Firestore 雲端同步（不需登入、自動儲存、跨裝置即時同步）
//  只同步「單字卡片」；API 金鑰不上雲，留在各裝置的瀏覽器。
// =========================================================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot,
  writeBatch, getDocs, getDoc,
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyD9mwoyTf1cAS7LTnVMy5lnfFEYW5mYBoY',
  authDomain: 'english-32702.firebaseapp.com',
  projectId: 'english-32702',
  storageBucket: 'english-32702.firebasestorage.app',
  messagingSenderId: '310094543091',
  appId: '1:310094543091:web:973e854f2bf9090624df86',
  measurementId: 'G-MF2FBXC1P3',
};

// 每位使用者的卡片存在 users/{uid}/{COLLECTION}
// 依語言切換 COLLECTION：英文用 'cards'、德文用 'cards_de' …
let COLLECTION = 'cards';
let UID = null; // 目前登入者的 uid（未登入時為 null）

let db, auth;
try {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
} catch (e) {
  console.error('Firebase 初始化失敗', e);
}

// Google 登入（已在 Firebase Console 啟用 Authentication）
window.Auth = {
  enabled: !!auth,
  user: null,
  async signInGoogle() {
    if (!auth) return;
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) { console.error('Google 登入失敗', e); alert('登入失敗：' + (e?.message || e)); }
  },
  async signOut() { if (auth) { try { await signOut(auth); } catch (e) { console.error(e); } } },
  onChange(cb) {
    if (!auth) { cb(null); return () => {}; }
    return onAuthStateChanged(auth, u => { window.Auth.user = u; cb(u); });
  },
};

// 依是否登入決定路徑：登入 → users/{uid}/{name}
const colRef = (name) => UID ? collection(db, 'users', UID, name) : collection(db, name);
const docRef = (name, id) => UID ? doc(db, 'users', UID, name, id) : doc(db, name, id);
const cardsCol = () => colRef(COLLECTION);

window.Cloud = {
  enabled: !!db,

  // 切換要同步的集合（語言切換時呼叫）
  setCollection(name) { COLLECTION = name || 'cards'; },

  // 設定目前使用者（登入/登出時呼叫）；每位使用者資料互相隔離
  setUser(uid) { UID = uid || null; },

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
    if (!db || !UID || !card || !card.id) return;
    try { await setDoc(docRef(COLLECTION, card.id), card); }
    catch (e) { console.error('雲端寫入失敗', e); }
  },

  async remove(id) {
    if (!db || !UID || !id) return;
    try { await deleteDoc(docRef(COLLECTION, id)); }
    catch (e) { console.error('雲端刪除失敗', e); }
  },

  // 批次寫入（匯入、首次同步用）；Firestore 單批上限 500
  async bulk(cardArr) {
    if (!db || !UID || !cardArr || !cardArr.length) return;
    try {
      for (let i = 0; i < cardArr.length; i += 400) {
        const batch = writeBatch(db);
        cardArr.slice(i, i + 400).forEach(c => {
          if (c && c.id) batch.set(docRef(COLLECTION, c.id), c);
        });
        await batch.commit();
      }
    } catch (e) { console.error('雲端批次寫入失敗', e); }
  },

  async clearAll() {
    if (!db || !UID) return;
    try {
      const snap = await getDocs(cardsCol());
      const docs = [];
      snap.forEach(d => docs.push(d.id));
      for (let i = 0; i < docs.length; i += 400) {
        const batch = writeBatch(db);
        docs.slice(i, i + 400).forEach(id => batch.delete(docRef(COLLECTION, id)));
        await batch.commit();
      }
    } catch (e) { console.error('雲端清空失敗', e); }
  },

  // 讀取使用者的中繼資料文件（users/{uid}/meta/{name}）
  async loadMeta(name) {
    if (!db || !UID || !name) return null;
    try {
      const snap = await getDoc(doc(db, 'users', UID, 'meta', name));
      return snap.exists() ? snap.data() : null;
    } catch (e) { console.error('讀取 meta 失敗', name, e); return null; }
  },
  // 寫入使用者的中繼資料文件
  async saveMeta(name, data) {
    if (!db || !UID || !name) return;
    try { await setDoc(doc(db, 'users', UID, 'meta', name), data); }
    catch (e) { console.error('寫入 meta 失敗', name, e); }
  },

  // 一次性搬移：把舊的「共用」頂層集合 name 複製到 users/{uid}/name
  // 回傳搬移的卡片數量。以卡片 id 為 doc id，重複執行不會產生重複。
  async migrateLegacy(uid, name) {
    if (!db || !uid || !name) return 0;
    try {
      const srcSnap = await getDocs(collection(db, name));
      if (srcSnap.empty) return 0;
      const items = [];
      srcSnap.forEach(d => items.push({ id: d.id, data: d.data() }));
      for (let i = 0; i < items.length; i += 400) {
        const batch = writeBatch(db);
        items.slice(i, i + 400).forEach(it => batch.set(doc(db, 'users', uid, name, it.id), it.data));
        await batch.commit();
      }
      return items.length;
    } catch (e) { console.error('搬移舊資料失敗', name, e); return 0; }
  },
};

// 通知 app.js 雲端已就緒
window.dispatchEvent(new Event('cloud-ready'));
