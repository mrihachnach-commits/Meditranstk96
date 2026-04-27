import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";
import { getFirestore as getAdminFirestore } from "firebase-admin/firestore";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load firebase config
let firebaseConfig: any;
try {
  const configPaths = [
    path.join(process.cwd(), "firebase-applet-config.json"),
    path.join(__dirname, "firebase-applet-config.json"),
    path.join(__dirname, "..", "firebase-applet-config.json"),
    "/var/task/firebase-applet-config.json"
  ];
  
  let configContent = null;
  for (const p of configPaths) {
    if (fs.existsSync(p)) {
      console.log("Found firebase config at:", p);
      configContent = fs.readFileSync(p, "utf8");
      break;
    }
  }

  if (!configContent) {
    console.warn("firebase-applet-config.json not found in common paths. Checking current directory...");
    const files = fs.readdirSync(process.cwd());
    if (files.includes("firebase-applet-config.json")) {
      configContent = fs.readFileSync(path.join(process.cwd(), "firebase-applet-config.json"), "utf8");
    }
  }

  if (!configContent) {
    throw new Error("firebase-applet-config.json missing. Please ensure it is uploaded to Vercel.");
  }
  
  firebaseConfig = JSON.parse(configContent);
} catch (err: any) {
  console.error("CRITICAL Error loading firebase config:", err.message);
  // We'll catch this later in the serverless handler
  firebaseConfig = { error: err.message };
}

// Set environment variables for firebase-admin
if (firebaseConfig.projectId) {
  process.env.GOOGLE_CLOUD_PROJECT = firebaseConfig.projectId;
}

// Initialize Firebase Admin (for token verification and administrative tasks)
let adminApp: admin.app.App | null = null;
if (!firebaseConfig.error) {
  try {
    if (admin.apps.length === 0) {
      adminApp = admin.initializeApp({ 
        projectId: firebaseConfig.projectId 
      });
      console.log(`Firebase Admin initialized for project: ${firebaseConfig.projectId}`);
    } else {
      adminApp = admin.apps[0]!;
    }
  } catch (e: any) {
    console.error("Failed to initialize Firebase Admin:", e.message);
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
     if (firebaseConfig.error) {
       console.error("[Admin Check] Configuration error:", firebaseConfig.error);
       return res.status(500).json({ 
         error: "Dịch vụ chưa được cấu hình đúng.", 
         details: firebaseConfig.error 
       });
     }

     if (!firebaseConfig.apiKey) {
       console.error("[Admin Check] API Key is missing from config");
       return res.status(500).json({ 
         error: "Thiếu Firebase API Key trong cấu hình." 
       });
     }

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
      console.log(`[Admin Check] Full verifyData: ${JSON.stringify(verifyData)}`);

      // 2. Check Admin Status
      const userEmail = (decodedToken.email || "").toLowerCase();
      const isPrimaryAdmin = userEmail === "hoanghiep1296@gmail.com" || 
                             userEmail === "mrihachnach@gmail.com" || 
                             userEmail === "admin@gmail.com" ||
                             userEmail === "hoctap853@gmail.com";

      console.log(`[Admin Check] Processing user: ${userEmail}, isPrimaryAdmin: ${isPrimaryAdmin}`);

      let userData: any = null;
      try {
        // Use Admin SDK for server-side checks
        const db = getAdminFirestore(adminApp, firebaseConfig.firestoreDatabaseId);
        const userDoc = await db.collection("users").doc(decodedToken.uid).get();
        
        if (userDoc.exists) {
          userData = userDoc.data();
          console.log(`[Admin Check] User document found. Role: ${userData?.role}`);
        } else {
          console.log(`[Admin Check] No user document found for UID: ${decodedToken.uid}`);
          if (!isPrimaryAdmin) {
            return res.status(403).json({ error: "Tài khoản của bạn chưa được thiết lập hoặc đã bị xóa." });
          }
        }
        
        // Check blacklist/blocked status
        if (userEmail) {
          const blacklistDoc = await db.collection("blacklist").doc(userEmail).get();
          if (blacklistDoc.exists) {
            console.log(`[Admin Check] User ${userEmail} is in blacklist.`);
            return res.status(403).json({ error: "Tài khoản của bạn đã bị chặn truy cập." });
          }
        }
      } catch (dbError: any) {
        // If Admin SDK fails (highly likely in some environments), log it as warning
        console.warn(`[Admin Check] Admin SDK DB fetch failed: ${dbError.message}`);
        
        // Primary admins can skip DB check if it fails
        if (!isPrimaryAdmin) {
          // Attempt REST fallback for non-primary admins if possible
          try {
             const restUser = await firestoreRest.getDoc("users", decodedToken.uid, idToken);
             if (restUser.exists) {
               userData = restUser.data;
               console.log(`[Admin Check] REST Fallback success. Role: ${userData?.role}`);
             }
          } catch (restErr: any) {
             console.error(`[Admin Check] REST Fallback also failed: ${restErr.message}`);
          }
        }
      }
      
      const isAdmin = userData?.role === "admin" || isPrimaryAdmin;

      if (!isAdmin) {
        console.log(`[Admin Check] Access denied for ${userEmail}. Not an admin.`);
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
      // 1. Attempt to create user in Firebase Auth via Admin SDK first (More robust)
      let uid: string;
      let dbSuccess = false;
      let authMethod = "admin-sdk";

      try {
        const userRecord = await admin.auth(adminApp).createUser({
          email,
          password,
          displayName: displayName || email.split('@')[0],
          emailVerified: true
        });
        uid = userRecord.uid;
        console.log(`[Admin] Successfully created user via Admin SDK: ${uid}`);
      } catch (adminError: any) {
        console.warn("[Admin] Admin SDK user creation failed, falling back to REST API:", adminError.message);
        authMethod = "rest-api";
        
        // 2. Fallback to Firebase Auth via REST API using API Key
        // This works because it's a "Public" signup style call
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
          if (errorCode === 'EMAIL_EXISTS') throw new Error("Email này đã được sử dụng.");
          if (errorCode?.includes('WEAK_PASSWORD')) throw new Error("Mật khẩu quá yếu.");
          throw new Error(signUpData.error?.message || "Lỗi khi tạo tài khoản");
        }
        uid = signUpData.localId;
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

      dbSuccess = true;
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
    try {
      // 1. Try Admin SDK first (fastest, bypasses rules)
      try {
        const usersSnapshot = await getAdminFirestore(adminApp, firebaseConfig.firestoreDatabaseId).collection("users").get();
        const users = usersSnapshot.docs.map(doc => ({
          id: doc.id,
          ...(doc.data() as any)
        }));
        
        return res.json({ 
          success: true, 
          users,
          projectId: firebaseConfig.projectId,
          databaseId: firebaseConfig.firestoreDatabaseId,
          source: "admin-sdk"
        });
      } catch (adminError: any) {
        console.warn("[Admin] Admin SDK list-users failed, falling back to REST API:", adminError.message);
        
        // 2. Fallback to REST API using the admin's token
        // This works because the admin's token HAS list permissions in security rules
        const idToken = req.headers.authorization.split("Bearer ")[1];
        const users = await firestoreRest.listDocs("users", idToken);
        
        res.json({ 
          success: true, 
          users,
          projectId: firebaseConfig.projectId,
          databaseId: firebaseConfig.firestoreDatabaseId,
          source: "rest-api-fallback"
        });
      }
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
    let authDeleted = false;
    let authError = null;

    try {
      // 1. Attempt to delete from Firebase Authentication using Admin SDK
      try {
        await admin.auth(adminApp).deleteUser(uid);
        authDeleted = true;
        console.log(`[Admin] Successfully deleted User Auth: ${uid}`);
      } catch (ae: any) {
        console.warn(`[Admin] Admin SDK Auth delete failed for ${uid}:`, ae.message);
        authError = ae.message;
        
        /**
         * EXPLANATION FOR USER:
         * You can ADD users but not DELETE them because:
         * 1. ADDING: Uses a Public API (SignUp) which only needs an API Key.
         * 2. DELETING: Uses a Restricted Administrative API that requires 
         *    'Identity Toolkit API' to be ENABLED in your project settings.
         */
        if (ae.message?.includes('identitytoolkit.googleapis.com') || ae.code === 'auth/internal-error') {
          authError = "Identity Toolkit API chưa được kích hoạt. Bạn có thể THÊM người dùng vì đó là tính năng công khai, " +
                     "nhưng để XÓA người dùng (tính năng quản trị), bạn PHẢI kích hoạt API này trong Console.";
        }
      }

      // 2. Delete Firestore document
      const db = getAdminFirestore(adminApp, firebaseConfig.firestoreDatabaseId);
      await db.collection("users").doc(uid).delete();
      
      // 3. Add to blacklist to prevent re-registration or access if Auth delete failed
      if (email) {
        await db.collection("blacklist").doc(email.toLowerCase()).set({
          email: email.toLowerCase(),
          uid: uid,
          reason: "Deleted by admin",
          authDeleted,
          createdAt: new Date().toISOString()
        });
      }
      
      res.json({ 
        success: true, 
        authDeleted,
        authError,
        message: authDeleted 
          ? "Đã xóa tài khoản khỏi hệ thống và xóa dữ liệu thành công." 
          : "Đã xóa dữ liệu và chặn truy cập (Xóa Auth thất bại: " + authError + ")"
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
  try {
    const app = await serverPromise;
    
    // Check if configuration failed during initialization
    if (firebaseConfig.error) {
      console.error("Serverless handler invoked but config is invalid:", firebaseConfig.error);
      if (req.url.startsWith("/api/")) {
        return res.status(500).json({ 
          error: "Server configuration error", 
          details: firebaseConfig.error,
          env: process.env.NODE_ENV
        });
      }
    }
    
    return app(req, res);
  } catch (error: any) {
    console.error("Vercel serverless function crashed:", error);
    res.status(500).json({ 
      error: "Internal Server Error", 
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};
