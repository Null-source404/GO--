# SonicCrate Security Audit Report
**Scan Date:** October 8, 2026  
**Status:** Post-remediation review + Critical vulnerabilities found

---

## 🚨 CRITICAL VULNERABILITIES

### 1. **Open Redirect via Verification Link (HIGH)**
**Location:** `server.js:196`, `server.js:231`, `server.js:286`  
**Severity:** HIGH (Phishing Vector)

```javascript
// ❌ VULNERABLE:
const verificationLink = `/?verifyToken=${encodeURIComponent(verificationToken)}&email=${encodeURIComponent(email)}`;
```

**Risk:** An attacker can craft a link with arbitrary URL parameters or redirect users off-site post-verification.

**Fix:**
```javascript
// ✅ SECURE:
const verificationLink = `/?verifyToken=${encodeURIComponent(verificationToken)}&email=${encodeURIComponent(email)}&_internal=verify`;
// Validate on client that this is a legitimate internal link
```

---

### 2. **Weak Password Hashing (CRITICAL)**
**Location:** `server.js:48-53`  
**Severity:** CRITICAL

```javascript
// ❌ VULNERABLE:
function hashPassword(email, password) {
  return crypto
    .createHash('sha256')
    .update(`${email.trim().toLowerCase()}:soniccrate:${password}`)
    .digest('hex');
}
```

**Risk:**
- SHA-256 is **not** suitable for password hashing (it's too fast, vulnerable to rainbow tables)
- Static salt (`soniccrate`) is publicly known
- No iterations/work factor → brute-force attacks feasible

**Fix:**
```javascript
import bcrypt from 'bcrypt';

async function hashPassword(email, password) {
  // Use bcrypt with cost factor of 12+ (adaptive, slow)
  const saltRounds = 12;
  return await bcrypt.hash(password, saltRounds);
}

// Verify:
async function verifyPassword(plaintext, hash) {
  return await bcrypt.compare(plaintext, hash);
}
```

---

### 3. **No Rate Limiting on Auth Endpoints (HIGH)**
**Location:** `server.js:168-208`, `server.js:210-245`, `server.js:301-330`  
**Severity:** HIGH (Brute Force + DDoS)

**Risk:** Attacker can enumerate users, brute-force passwords, or DOS the service.

**Fix:**
```javascript
import rateLimit from 'express-rate-limit';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per IP
  message: 'Too many auth attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/auth/register', authLimiter, (req, res) => { /* ... */ });
app.post('/auth/login', authLimiter, (req, res) => { /* ... */ });
app.get('/auth/verify', authLimiter, (req, res) => { /* ... */ });
```

---

### 4. **Session Storage in Memory (HIGH)**
**Location:** `server.js:17-20`  
**Severity:** HIGH (Loss on Restart + No Persistence)

```javascript
// ❌ VULNERABLE:
const sessions = new Map(); // Lost on server restart
const streamCache = new Map();
const ytCache = new Map();
```

**Risk:**
- Sessions lost if server crashes/restarts
- No horizontal scalability (load balancing breaks)
- Unbounded cache growth → memory leak

**Fix:**
```javascript
// Use Redis or signed JWT tokens instead:
import jwt from 'jsonwebtoken';

function generateSessionToken(email) {
  return jwt.sign(
    { email, iat: Math.floor(Date.now() / 1000) },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function verifySessionToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (_) {
    return null;
  }
}
```

---

### 5. **No CSRF Protection (MEDIUM)**
**Location:** All POST endpoints (`server.js:168`, `server.js:210`, `server.js:247`, `server.js:332`)  
**Severity:** MEDIUM (State-Changing Requests)

**Risk:** Cross-site form forgery can register/login/logout users without their knowledge.

**Fix:**
```javascript
import csrf from 'csurf';
import cookieParser from 'cookie-parser';

const csrfProtection = csrf({ cookie: true });
app.use(cookieParser());

app.post('/auth/register', csrfProtection, (req, res) => {
  // Verify CSRF token from req.body._csrf
});

// Provide CSRF token in HTML forms:
// <input type="hidden" name="_csrf" value="<%= csrfToken %>">
```

---

### 6. **SQL Injection-like Vulnerability in Query Parameters (MEDIUM)**
**Location:** `server.js:364`, `server.js:405`, `server.js:678`  
**Severity:** MEDIUM (External API Injection)

```javascript
// ❌ At risk:
const query = `${trackName} ${artistName} official audio`;
const searchURL = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
```

**Risk:** If attacker controls `trackName` or `artistName`, they can inject malicious parameters into external APIs.

**Mitigation (Partial - External API):**
```javascript
// Sanitize before building URLs:
function sanitizeSearchTerm(term) {
  return String(term || '')
    .trim()
    .slice(0, 200) // Limit length
    .replace(/[^\w\s\-]/g, ''); // Remove special chars
}

const query = `${sanitizeSearchTerm(trackName)} ${sanitizeSearchTerm(artistName)} official audio`;
```

---

### 7. **No Input Validation on `/stream` Endpoint (HIGH)**
**Location:** `server.js:423-470`  
**Severity:** HIGH (Server-Side Request Forgery)

```javascript
// ❌ VULNERABLE:
app.get('/stream', async (req, res) => {
  const track = String(req.query.track || '').trim();
  const artist = String(req.query.artist || '').trim();
  const previewUrl = String(req.query.preview || '').trim(); // ← User-controlled URL

  let targetUrl = previewUrl;
  // ... fetches targetUrl without validation
  let upstream = await fetch(targetUrl, { headers });
```

**Risk:** SSRF — attacker can make the server fetch arbitrary URLs (internal networks, file://, etc.).

**Fix:**
```javascript
function isValidAudioUrl(url) {
  try {
    const parsed = new URL(url);
    // Whitelist safe domains
    const allowed = ['itunes.apple.com', 'audius.co', 'youtube.com'];
    return allowed.some(domain => parsed.hostname.includes(domain));
  } catch (_) {
    return false;
  }
}

app.get('/stream', async (req, res) => {
  const previewUrl = String(req.query.preview || '').trim();
  if (!isValidAudioUrl(previewUrl)) {
    return res.status(400).send('Invalid audio URL');
  }
  // ... rest of stream logic
});
```

---

### 8. **No HTTPS Enforcement (MEDIUM)**
**Location:** Multiple endpoints set `Access-Control-Allow-Origin: *`  
**Severity:** MEDIUM (Man-in-the-Middle Risk)

```javascript
// ❌ VULNERABLE:
res.setHeader('Access-Control-Allow-Origin', '*'); // Allows HTTP
```

**Risk:** Credentials, tokens, and user data can be intercepted over HTTP.

**Fix:**
```javascript
app.use((req, res, next) => {
  // In production, enforce HTTPS
  if (process.env.NODE_ENV === 'production' && req.protocol !== 'https') {
    return res.status(403).send('HTTPS required');
  }
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGINS || 'https://yourdomain.com');
  next();
});
```

---

### 9. **Timing Attack on Email Verification (LOW)**
**Location:** `server.js:306-310`  
**Severity:** LOW (Information Leakage)

```javascript
// ❌ VULNERABLE:
if (
  !record ||
  (verifyTok && record.verificationToken && record.verificationToken !== verifyTok)
) {
  return res.status(400).send('Invalid or expired verification link');
}
```

**Risk:** Attacker can measure response time to deduce if email exists.

**Fix:** Use `crypto.timingSafeEqual()`:
```javascript
const crypto = require('crypto');

if (!record) {
  return res.status(400).send('Invalid or expired verification link');
}

let tokenValid = false;
if (verifyTok && record.verificationToken) {
  try {
    tokenValid = crypto.timingSafeEqual(
      Buffer.from(verifyTok),
      Buffer.from(record.verificationToken)
    );
  } catch (_) {
    tokenValid = false;
  }
}

if (!tokenValid) {
  return res.status(400).send('Invalid or expired verification link');
}
```

---

### 10. **users.json File Permissions (HIGH)**
**Location:** `server.js:16`, `server.js:37-44`  
**Severity:** HIGH (Local Privilege Escalation + Data Exposure)

```javascript
const USERS_FILE = path.join(__dirname, 'Song', 'server', 'users.json');
// No file permission checks; world-readable by default
fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), 'utf-8');
```

**Risk:**
- Other users on the server can read password hashes
- No encryption at rest

**Fix:**
```javascript
import fs from 'fs';

function saveUsersToDisk() {
  try {
    const list = Array.from(usersByEmail.values());
    const data = JSON.stringify(list, null, 2);
    // Write with restricted permissions (0600 = owner only)
    fs.writeFileSync(USERS_FILE, data, { mode: 0o600, encoding: 'utf-8' });
  } catch (err) {
    console.error('Failed to save users:', err);
  }
}

// On startup, verify file permissions:
function verifyFilePermissions() {
  if (fs.existsSync(USERS_FILE)) {
    const stats = fs.statSync(USERS_FILE);
    if ((stats.mode & 0o077) !== 0) {
      console.warn('⚠️  users.json has insecure permissions; fixing...');
      fs.chmodSync(USERS_FILE, 0o600);
    }
  }
}
```

---

## ⚠️ MEDIUM SEVERITY ISSUES

### 11. **No Content Security Policy (CSP)**
**Severity:** MEDIUM (XSS Mitigation)

**Fix:**
```javascript
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://www.youtube.com https://www.gstatic.com",
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
    "img-src 'self' https: data:",
    "font-src 'self' https://fonts.gstatic.com",
    "frame-src https://www.youtube.com",
  ].join('; '));
  next();
});
```

---

### 12. **No HTTP Security Headers**
**Severity:** MEDIUM (Defense-in-Depth)

**Fix:**
```javascript
import helmet from 'helmet';

app.use(helmet()); // Adds X-Frame-Options, X-Content-Type-Options, etc.

app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
```

---

### 13. **Unbounded Caches (ytCache, streamCache)**
**Location:** `server.js:19-20`, `server.js:365-389`, `server.js:397-420`  
**Severity:** MEDIUM (DoS + Memory Exhaustion)

**Risk:** No eviction policy → memory leak over time.

**Fix:**
```javascript
import NodeCache from 'node-cache';

const ytCache = new NodeCache({ stdTTL: 3600 }); // 1 hour
const streamCache = new NodeCache({ stdTTL: 1800 }); // 30 min
```

---

### 14. **No Firestore Rule Enforcement on Server Side**
**Location:** `server.js:247-299` (`/auth/firebase-sync`)  
**Severity:** MEDIUM (Authorization Bypass)

**Risk:** Backend accepts Firebase user data without verifying against Firestore rules.

**Fix:**
```javascript
import admin from 'firebase-admin';

async function firebaseSyncHandler(w http.ResponseWriter, r *http.Request) {
  uid := strings.TrimSpace(r.FormValue("uid"))
  email := strings.TrimSpace(r.FormValue("email"))
  
  // Verify this uid matches an actual Firebase Auth user
  ctx := context.Background()
  firebaseUser, err := client.Auth(ctx).GetUser(ctx, uid)
  if err != nil || firebaseUser.Email != email {
    http.Error(w, "Unauthorized", http.StatusUnauthorized)
    return
  }
  
  // Now proceed with sync
}
```

---

## ✅ POSITIVE SECURITY CONTROLS (Already in place)

1. **Firestore Security Rules** — Strict default-deny with proper UID validation ✓
2. **Email Verification** — Prevents mass account creation ✓
3. **HTML Escaping** — `escapeHtml()` prevents XSS in client output ✓
4. **Input Trimming** — Reduces injection surface ✓
5. **Environment Variable Support** — `.env.example` prevents hardcoded secrets ✓
6. **Firebase Config Placeholder** — No leaked credentials in current commit ✓

---

## 🔧 Remediation Roadmap

| Priority | Issue | Fix Time | Notes |
|----------|-------|----------|-------|
| **CRITICAL** | Weak password hashing → bcrypt | 1 hour | Do immediately |
| **HIGH** | No rate limiting | 30 min | Prevent brute-force |
| **HIGH** | SSRF in `/stream` | 1 hour | Validate URLs |
| **HIGH** | Session storage in memory → JWT | 2 hours | Enable scaling |
| **HIGH** | users.json permissions | 15 min | File chmod(0600) |
| **MEDIUM** | No CSRF protection | 1 hour | Add csurf middleware |
| **MEDIUM** | Missing security headers | 30 min | Add helmet |
| **MEDIUM** | Unbounded caches | 15 min | Add TTL/eviction |
| **MEDIUM** | No HTTPS enforcement | 1 hour | Redirect HTTP→HTTPS |
| **LOW** | Timing attack on email verify | 30 min | Use timingSafeEqual() |

---

## 📋 Implementation Checklist

- [ ] Replace SHA-256 password hashing with bcrypt
- [ ] Add rate limiting to `/auth/*` endpoints
- [ ] Implement URL validation on `/stream` endpoint
- [ ] Migrate sessions from in-memory Map to JWT or Redis
- [ ] Set file permissions on `users.json` to 0600
- [ ] Add CSRF protection middleware
- [ ] Install & configure helmet.js
- [ ] Add TTL to ytCache and streamCache
- [ ] Enforce HTTPS in production
- [ ] Use crypto.timingSafeEqual() for token comparison
- [ ] Add comprehensive error logging (without leaking details)
- [ ] Implement authentication audit logs

---

## 📖 References

- [OWASP Top 10 2021](https://owasp.org/Top10/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [Firebase Security Rules Guide](https://firebase.google.com/docs/rules)
- [bcrypt npm](https://www.npmjs.com/package/bcrypt)
- [express-rate-limit](https://www.npmjs.com/package/express-rate-limit)
- [helmet.js](https://helmetjs.github.io/)

---

**Report Generated:** 2026-10-08  
**Next Audit:** After implementing HIGH/CRITICAL fixes
