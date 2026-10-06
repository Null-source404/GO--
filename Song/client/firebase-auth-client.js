import { initializeApp } from 'firebase/app';
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
  updateProfile,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  applyActionCode,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  writeBatch,
  serverTimestamp,
} from 'firebase/firestore';

const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
};

let app = null;
let auth = null;
let db = null;
let firebaseConfigData = null;

function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid || null,
      email: auth?.currentUser?.email || null,
      emailVerified: auth?.currentUser?.emailVerified ?? null,
      isAnonymous: auth?.currentUser?.isAnonymous ?? null,
      tenantId: auth?.currentUser?.tenantId || null,
      providerInfo:
        auth?.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  if (!db) return;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

async function syncVerifiedProfileToFirestore(user, customDisplayName = '') {
  if (!db || !user || !user.uid || !user.emailVerified) return;

  const safeUid = String(user.uid).slice(0, 128);
  const rawName = (customDisplayName || user.displayName || user.email?.split('@')[0] || 'Member').trim();
  const safeName = rawName.slice(0, 80) || 'Member';
  const safeEmail = String(user.email || '').trim().slice(0, 254);

  const userRef = doc(db, 'users', safeUid);
  const privateRef = doc(db, 'users', safeUid, 'private', 'info');

  try {
    const existingSnap = await getDoc(userRef);
    const batch = writeBatch(db);

    if (!existingSnap.exists()) {
      batch.set(userRef, {
        ownerId: safeUid,
        displayName: safeName,
        emailVerified: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      if (safeEmail.length >= 3) {
        batch.set(privateRef, {
          ownerId: safeUid,
          email: safeEmail,
          createdAt: serverTimestamp(),
        });
      }
    } else {
      const existingData = existingSnap.data();
      batch.update(userRef, {
        ownerId: existingData.ownerId,
        displayName: safeName,
        emailVerified: true,
        createdAt: existingData.createdAt,
        updatedAt: serverTimestamp(),
      });
    }

    await batch.commit();
  } catch (error) {
    if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
      handleFirestoreError(error, OperationType.WRITE, `users/${safeUid}`);
    }
  }
}

async function initSonicFirebase() {
  try {
    const res = await fetch('/firebase-applet-config.json');
    if (!res.ok) return;
    firebaseConfigData = await res.json();
    if (!firebaseConfigData || !firebaseConfigData.apiKey) return;

    app = initializeApp(firebaseConfigData);
    db = getFirestore(app, firebaseConfigData.firestoreDatabaseId);
    auth = getAuth(app);

    testConnection();

    // Handle Firebase email verification action code if user lands with ?mode=verifyEmail&oobCode=...
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('mode');
    const oobCode = params.get('oobCode');
    if (mode === 'verifyEmail' && oobCode && auth) {
      try {
        await applyActionCode(auth, oobCode);
        if (auth.currentUser) {
          await auth.currentUser.reload();
        }
        if (typeof window.onFirebaseEmailVerifiedBanner === 'function') {
          window.onFirebaseEmailVerifiedBanner('Your email link was verified with Firebase Authentication! Account acknowledged.');
        }
      } catch (_) {}
    }

    onAuthStateChanged(auth, async (user) => {
      if (user) {
        if (user.emailVerified) {
          await syncVerifiedProfileToFirestore(user).catch(() => {});
        }
        if (typeof window.handleFirebaseUserState === 'function') {
          window.handleFirebaseUserState({
            uid: user.uid,
            name: user.displayName || (user.email ? user.email.split('@')[0] : 'Member'),
            email: user.email || '',
            emailVerified: Boolean(user.emailVerified),
          });
        }
      }
    });
  } catch (err) {
    console.error('Firebase initialization warning:', err);
  }
}

window.SonicFirebaseAuth = {
  isReady() {
    return Boolean(auth);
  },
  getProjectId() {
    return firebaseConfigData?.projectId || 'gen-lang-client-0753686889';
  },
  async registerWithEmail(name, email, password) {
    if (!auth) throw new Error('Firebase Auth is not initialized yet.');
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    if (name) {
      await updateProfile(cred.user, { displayName: name });
    }
    const continueUrl = `${window.location.origin}/?emailVerifiedAck=1&email=${encodeURIComponent(email)}`;
    await sendEmailVerification(cred.user, {
      url: continueUrl,
      handleCodeInApp: false,
    });
    return {
      uid: cred.user.uid,
      name: name || cred.user.displayName || email.split('@')[0],
      email: cred.user.email || email,
      emailVerified: Boolean(cred.user.emailVerified),
      verificationEmailSent: true,
    };
  },
  async loginWithEmail(email, password) {
    if (!auth) throw new Error('Firebase Auth is not initialized yet.');
    const cred = await signInWithEmailAndPassword(auth, email, password);
    await cred.user.reload();
    if (cred.user.emailVerified) {
      await syncVerifiedProfileToFirestore(cred.user).catch(() => {});
    }
    return {
      uid: cred.user.uid,
      name: cred.user.displayName || email.split('@')[0],
      email: cred.user.email || email,
      emailVerified: Boolean(cred.user.emailVerified),
    };
  },
  async loginWithGoogle() {
    if (!auth) throw new Error('Firebase Auth is not initialized yet.');
    const provider = new GoogleAuthProvider();
    const cred = await signInWithPopup(auth, provider);
    if (cred.user.emailVerified) {
      await syncVerifiedProfileToFirestore(cred.user).catch(() => {});
    }
    return {
      uid: cred.user.uid,
      name: cred.user.displayName || (cred.user.email ? cred.user.email.split('@')[0] : 'Member'),
      email: cred.user.email || '',
      emailVerified: Boolean(cred.user.emailVerified),
    };
  },
  async resendVerificationEmail() {
    if (!auth || !auth.currentUser) {
      throw new Error('Sign in first to resend your verification email link.');
    }
    const email = auth.currentUser.email || '';
    const continueUrl = `${window.location.origin}/?emailVerifiedAck=1&email=${encodeURIComponent(email)}`;
    await sendEmailVerification(auth.currentUser, {
      url: continueUrl,
      handleCodeInApp: false,
    });
    return true;
  },
  async checkVerificationStatus() {
    if (!auth || !auth.currentUser) return null;
    await auth.currentUser.reload();
    if (auth.currentUser.emailVerified) {
      await syncVerifiedProfileToFirestore(auth.currentUser).catch(() => {});
    }
    return {
      uid: auth.currentUser.uid,
      name: auth.currentUser.displayName || (auth.currentUser.email ? auth.currentUser.email.split('@')[0] : 'Member'),
      email: auth.currentUser.email || '',
      emailVerified: Boolean(auth.currentUser.emailVerified),
    };
  },
  async signOutUser() {
    if (auth) {
      await signOut(auth).catch(() => {});
    }
  },
};

initSonicFirebase();
