import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";
import { getFirestore as getAdminFirestore } from "firebase-admin/firestore";
import { initializeApp as initializeClientApp } from "firebase/app";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load firebase config
const configPath = path.join(process.cwd(), "firebase-applet-config.json");
if (!fs.existsSync(configPath)) {
  console.error("CRITICAL: firebase-applet-config.json not found at", configPath);
  console.log("Current directory:", process.cwd());
  console.log("Files in current directory:", fs.readdirSync(process.cwd()));
  throw new Error("firebase-applet-config.json missing. Please ensure it is uploaded to Vercel.");
}
const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));

// Set environment variables for firebase-admin
process.env.GOOGLE_CLOUD_PROJECT = firebaseConfig.projectId;

// Initialize Firebase Admin (for token verification)
let adminApp: admin.app.App;
try {
  const appName = "user-project-app";
  const existingApp = admin.apps.find(app => app?.name === appName);
  
  if (!existingApp) {
    adminApp = admin.initializeApp({ 
      projectId: firebaseConfig.projectId 
    }, appName);
    console.log(`Firebase Admin initialized for project: ${firebaseConfig.projectId} (App: ${appName})`);
  } else {
    adminApp = existingApp!;
    console.log(`Using existing Firebase Admin app: ${adminApp.name}`);
  }
} catch (e: any) {
  console.error("Failed to initialize Firebase Admin:", e.message);
  if (admin.apps.length > 0) {
    adminApp = admin.apps[0]!;
  } else {
    adminApp = admin.initializeApp({ projectId: firebaseConfig.projectId });
  }
}

// Initialize Firestore Helper using REST API
const firestoreRest = {
  getDoc: async (collection: string, docId: string, idToken?: string) => {
    const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents/${collection}/${docId}`;
    const headers: any = { 'Content-Type': 'application/json' };
    if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
    
    const res = await fetch(url, { headers });
    if (res.status === 404) return { exists: false };
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error?.message || "Firestore REST error");
    }
    const data = await res.json();
    return { exists: true, data: parseFirestoreFields(data.fields) };
  },
  
  setDoc: async (collection: string, docId: string, data: any, idToken?: string) => {
    const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents/${collection}/${docId}`;
    const headers: any = { 'Content-Type': 'application/json' };
    if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
    
    const body = { fields: encodeFirestoreFields(data) };
    const res = await fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body)
    });
    
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error?.message || "Firestore REST error");
    }
    return await res.json();
  },

  deleteDoc: async (collection: string, docId: string, idToken?: string) => {
    const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents/${collection}/${docId}`;
    const headers: any = { 'Content-Type': 'application/json' };
    if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
    
    const res = await fetch(url, { method: 'DELETE', headers });
    if (!res.ok && res.status !== 404) {
      const error = await res.json();
      throw new Error(error.error?.message || "Firestore REST error");
    }
    return true;
  },

  listDocs: async (collection: string, idToken?: string) => {
    const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents/${collection}`;
    const headers: any = { 'Content-Type': 'application/json' };
    if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
    
    console.log(`[Firestore REST] Listing ${collection} from ${url}`);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const error = await res.json();
      console.error(`[Firestore REST] List failed:`, JSON.stringify(error));
      throw new Error(error.error?.message || "Firestore REST error");
    }
    const data = await res.json();
    return (data.documents || []).map((doc: any) => ({
      id: doc.name.split('/').pop(),
      ...parseFirestoreFields(doc.fields)
    }));
  }
};

// Helper to parse Firestore REST fields
function parseFirestoreFields(fields: any) {
  if (!fields) return {};
  const result: any = {};
  for (const key in fields) {
    const valueObj = fields[key];
    if ('stringValue' in valueObj) result[key] = valueObj.stringValue;
    else if ('integerValue' in valueObj) result[key] = parseInt(valueObj.integerValue);
    else if ('doubleValue' in valueObj) result[key] = valueObj.doubleValue;
    else if ('booleanValue' in valueObj) result[key] = valueObj.booleanValue;
    else if ('timestampValue' in valueObj) result[key] = valueObj.timestampValue;
    else if ('mapValue' in valueObj) result[key] = parseFirestoreFields(valueObj.mapValue.fields);
    else if ('arrayValue' in valueObj) {
      result[key] = (valueObj.arrayValue.values || []).map((v: any) => {
        const temp = parseFirestoreFields({ temp: v });
        return temp.temp;
      });
    }
  }
  return result;
}

// Helper to encode Firestore REST fields
function encodeFirestoreFields(data: any) {
  const fields: any = {};
  for (const key in data) {
    const val = data[key];
    if (typeof val === 'string') fields[key] = { stringValue: val };
    else if (typeof val === 'number') {
      if (Number.isInteger(val)) fields[key] = { integerValue: val.toString() };
      else fields[key] = { doubleValue: val };
    }
    else if (typeof val === 'boolean') fields[key] = { booleanValue: val };
    else if (val instanceof Date) fields[key] = { timestampValue: val.toISOString() };
    else if (Array.isArray(val)) {
      fields[key] = { arrayValue: { values: val.map(v => encodeFirestoreFields({ temp: v }).temp) } };
    }
    else if (typeof val === 'object' && val !== null) {
      fields[key] = { mapValue: { fields: encodeFirestoreFields(val) } };
    }
  }
  return fields;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Middleware to check if user is admin
  const checkAdmin = async (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const idToken = authHeader.split("Bearer ")[1];
    if (!idToken || idToken === "null" || idToken === "undefined") {
      return res.status(401).json({ error: "Invalid token: Token is missing or null" });
    }

    try {
      // 1. Verify token using REST API (Always uses user's API Key and Project)
      const verifyRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseConfig.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      });
      
      const verifyData: any = await verifyRes.json();
      
      if (!verifyRes.ok || !verifyData.users || verifyData.users.length === 0) {
        throw new Error(verifyData.error?.message || "Token verification failed");
      }

      const decodedToken = verifyData.users[0];
      decodedToken.uid = decodedToken.localId; // Map localId to uid for consistency
      console.log(`[Admin Check] Verified user: ${decodedToken.email} (${decodedToken.uid})`);

      // 2. Check Admin Status
      let userData: any = null;
      try {
        // Use REST API with the user's token to check their own document
        const userDoc = await firestoreRest.getDoc("users", decodedToken.uid, idToken);
        if (!userDoc.exists) {
          return res.status(403).json({ error: "Tài khoản của bạn đã bị xóa hoặc bị chặn." });
        }
        userData = userDoc.data;
        
        // Check blacklist
        if (decodedToken.email) {
          const blacklistDoc = await firestoreRest.getDoc("blacklist", decodedToken.email.toLowerCase(), idToken);
          if (blacklistDoc.exists) {
            return res.status(403).json({ error: "Tài khoản của bạn đã bị chặn truy cập." });
          }
        }
      } catch (dbError: any) {
        console.error("Firestore fetch failed in admin check:", dbError.message);
        // If it's a permission error, we might still be a primary admin
      }
      
      const isPrimaryAdmin = decodedToken.email === "hoanghiep1296@gmail.com" || 
                             decodedToken.email === "mrihachnach@gmail.com" || 
                             decodedToken.email === "admin@gmail.com" ||
                             decodedToken.email === "hoctap853@gmail.com";
      
      const isAdmin = userData?.role === "admin" || isPrimaryAdmin;

      if (!isAdmin) {
        return res.status(403).json({ error: "Forbidden: Admin access required" });
      }
      req.user = decodedToken;
      next();
    } catch (error: any) {
      console.error("Admin check failed:", error.message);
      res.status(401).json({ error: `Invalid token: ${error.message}` });
    }
  };

  // Diagnostic Endpoint
  app.get("/api/admin/diagnostics", checkAdmin, async (req, res) => {
    const idToken = req.headers.authorization.split("Bearer ")[1];
    const results: any = {
      projectId: firebaseConfig.projectId,
      databaseId: firebaseConfig.firestoreDatabaseId,
      auth: { status: "unknown" },
      firestore: { status: "unknown" },
      env: {
        GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
        NODE_ENV: process.env.NODE_ENV
      }
    };

    try {
      // Test Auth REST API
      const verifyRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseConfig.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      });
      if (verifyRes.ok) {
        results.auth.status = "ok";
      } else {
        results.auth.status = "error";
        results.auth.message = (await verifyRes.json()).error?.message;
      }
    } catch (e: any) {
      results.auth.status = "error";
      results.auth.message = e.message;
    }

    try {
      // Test Firestore REST API
      await firestoreRest.getDoc("test_connection", "diagnostic", idToken);
      results.firestore.status = "ok";
    } catch (e: any) {
      results.firestore.status = "error";
      results.firestore.message = e.message;
    }

    res.json(results);
  });

  // Proxy TinyVault Upload (Vercel-style proxy for local dev/Cloud Run)
  app.post("/api/tinyvault", async (req, res) => {
    try {
      const { default: axios } = await import("axios");
      const { default: FormData } = await import("form-data");
      const { default: multer } = await import("multer");
      const upload = multer({ 
        storage: multer.memoryStorage(),
        limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
      });

      upload.single("file")(req as any, res as any, async (err) => {
        const request = req as any;
        if (err) {
          console.error("Multer error:", err);
          return res.status(500).json({ error: "Lỗi xử lý tệp tin: " + err.message });
        }
        if (!request.file) return res.status(400).json({ error: "Không có tệp tin nào được tải lên" });

        const formData = new FormData();
        formData.append("file", request.file.buffer, {
          filename: request.file.originalname,
          contentType: request.file.mimetype,
        });

        try {
          const response = await axios.post("https://tinyvault.space/api/upload", formData, {
            headers: { ...formData.getHeaders() },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 60000 // 60 seconds timeout
          });
          res.json(response.data);
        } catch (axiosError: any) {
          console.error("TinyVault API error:", axiosError.response?.data || axiosError.message);
          res.status(axiosError.response?.status || 500).json({ 
            error: "Lỗi từ máy chủ TinyVault", 
            details: axiosError.response?.data || axiosError.message 
          });
        }
      });
    } catch (error: any) {
      console.error("Proxy internal error:", error);
      res.status(500).json({ error: "Lỗi hệ thống nội bộ: " + error.message });
    }
  });

  // API Routes
  
  // Admin: Create User
  app.post("/api/admin/create-user", checkAdmin, async (req, res) => {
    const { email, password, displayName, role } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: "Email và mật khẩu là bắt buộc" });
    }

    try {
      // 1. Create user in Firebase Auth via REST API
      const signUpResponse = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${firebaseConfig.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          displayName: displayName || email.split('@')[0],
          returnSecureToken: true
        })
      });

      const signUpData: any = await signUpResponse.json();
      
      if (!signUpResponse.ok) {
        const errorCode = signUpData.error?.message;
        if (errorCode === 'EMAIL_EXISTS') {
          throw new Error("Email này đã được sử dụng.");
        } else if (errorCode?.includes('WEAK_PASSWORD')) {
          throw new Error("Mật khẩu quá yếu.");
        }
        
        if (signUpData.error?.status === 'PERMISSION_DENIED' || signUpData.error?.message?.includes('Identity Toolkit API')) {
          return res.status(500).json({ 
            error: "Lỗi hệ thống: Identity Toolkit API chưa được kích hoạt.",
            details: `Bạn PHẢI kích hoạt Identity Toolkit API.\n\nCách 1 (Dễ nhất): Vào Firebase Console -> Authentication -> Nhấn 'Get Started'.\nLink: https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication\n\nCách 2: Kích hoạt trực tiếp API tại Google Cloud Console.\nLink: https://console.developers.google.com/apis/api/identitytoolkit.googleapis.com/overview?project=${firebaseConfig.projectId}`,
            apiLink: `https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication`
          });
        }
        
        throw new Error(signUpData.error?.message || "Lỗi khi tạo tài khoản");
      }

      const uid = signUpData.localId;
      const idToken = signUpData.idToken;

      // 2. Set emailVerified to true via REST API
      try {
        await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:update?key=${firebaseConfig.apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idToken,
            emailVerified: true,
            returnSecureToken: false
          })
        });
      } catch (updateError) {
        console.warn("Failed to set emailVerified via REST API:", updateError);
      }
      
      // 3. Create user document in Firestore (Optional on server)
      const userData = {
        uid,
        email,
        displayName: displayName || email.split('@')[0],
        role: role || "user",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      let dbSuccess = true;
      try {
        // Use the admin's token from the request to write to Firestore
        const adminToken = req.headers.authorization.split("Bearer ")[1];
        await firestoreRest.setDoc("users", uid, userData, adminToken);
        
        // 4. Also add to blacklist if needed (optional)
        // Note: By default users are NOT in blacklist when created
        // But we keep the logic structure if you want to track something else
      } catch (dbError: any) {
        // Suppress expected permission logs as we have a client-side fallback
        if (!dbError.message.includes("PERMISSION_DENIED") && !dbError.message.includes("574247538815")) {
          console.error("Firestore update failed during user creation:", dbError.message);
        }
        dbSuccess = false;
      }
      
      res.json({ 
        success: true, 
        uid, 
        dbSuccess,
        userData: {
          ...userData,
          createdAt: new Date().toISOString() // Fallback for client
        }
      });
    } catch (error: any) {
      console.error("[Admin] Error creating user:", error);
      
      if (error.message.includes("Identity Toolkit API") || error.code === 'auth/internal-error') {
        return res.status(500).json({ 
          error: "Lỗi hệ thống: Identity Toolkit API chưa được kích hoạt.",
          details: `Bạn PHẢI kích hoạt Identity Toolkit API.\n\nCách 1 (Dễ nhất): Vào Firebase Console -> Authentication -> Nhấn 'Get Started'.\nLink: https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication\n\nCách 2: Kích hoạt trực tiếp API tại Google Cloud Console.\nLink: https://console.developers.google.com/apis/api/identitytoolkit.googleapis.com/overview?project=${firebaseConfig.projectId}`,
          apiLink: `https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication`
        });
      }

      let errorMessage = error.message;
      if (error.code === 'auth/email-already-exists') {
        errorMessage = "Email này đã được sử dụng.";
      } else if (error.code === 'auth/invalid-password') {
        errorMessage = "Mật khẩu không hợp lệ (tối thiểu 6 ký tự).";
      }
      
      res.status(400).json({ error: errorMessage });
    }
  });

  // Admin: List Users (Source from Firestore only to avoid project mismatch)
  app.get("/api/admin/list-users", checkAdmin, async (req, res) => {
    const idToken = req.headers.authorization.split("Bearer ")[1];
    try {
      const users = await firestoreRest.listDocs("users", idToken);
      res.json({ 
        success: true, 
        users,
        projectId: firebaseConfig.projectId,
        databaseId: firebaseConfig.firestoreDatabaseId
      });
    } catch (error: any) {
      console.error("[Admin] List users failed:", error.message);
      res.status(500).json({ error: "Không thể lấy danh sách người dùng: " + error.message });
    }
  });

  // Admin: Reset Password (Soft Reset - Notify user to use email reset)
  app.post("/api/admin/reset-password", checkAdmin, async (req, res) => {
    res.status(400).json({ 
      error: "Tính năng đặt mật khẩu trực tiếp bị hạn chế bởi Firebase.",
      details: "Để bảo mật, vui lòng sử dụng nút 'Gửi email đặt lại mật khẩu' để người dùng tự đặt mật khẩu mới."
    });
  });

  // Admin: Delete User (Soft Delete + Firestore Cleanup)
  app.post("/api/admin/delete-user", checkAdmin, async (req, res) => {
    const { uid, email } = req.body;
    const idToken = req.headers.authorization.split("Bearer ")[1];
    try {
      // We only perform Soft Delete (Firestore + Blacklist) to avoid Identity Toolkit API issues
      await firestoreRest.deleteDoc("users", uid, idToken);
      
      if (email) {
        await firestoreRest.setDoc("blacklist", email.toLowerCase(), {
          email: email.toLowerCase(),
          uid: uid,
          reason: "Deleted by admin",
          createdAt: new Date().toISOString()
        }, idToken);
      }
      
      res.json({ 
        success: true, 
        message: "Đã chặn truy cập và xóa dữ liệu người dùng thành công."
      });
    } catch (error: any) {
      console.error("[Admin] Error in delete-user route:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    
    // API 404 handler to prevent returning index.html for missing API routes
    app.use("/api/*", (req, res) => {
      res.status(404).json({ error: `API route not found: ${req.originalUrl}` });
    });

    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Always listen on port 3000 in this environment
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  return app;
}

const serverPromise = startServer();

export default async (req: any, res: any) => {
  const app = await serverPromise;
  return app(req, res);
};
