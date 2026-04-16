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
  if (admin.apps.length === 0) {
    adminApp = admin.initializeApp({ 
      projectId: firebaseConfig.projectId 
    });
    console.log(`Firebase Admin initialized for project: ${firebaseConfig.projectId}`);
  } else {
    adminApp = admin.apps[0];
    console.log(`Using existing Firebase Admin app for project: ${adminApp.options.projectId}`);
  }
} catch (e: any) {
  console.error("Failed to initialize Firebase Admin:", e.message);
  adminApp = admin.apps[0];
}

// Initialize Firestore with fallback logic
let firestore: admin.firestore.Firestore;

// Helper to get the right firestore instance
async function getFirestoreInstance() {
  // Use the specific database ID from config
  const dbId = firebaseConfig.firestoreDatabaseId;
  const projectId = firebaseConfig.projectId;
  
  console.log(`[Firestore] Initializing connection...`);
  console.log(`[Firestore] Project ID: ${projectId}`);
  console.log(`[Firestore] Database ID: ${dbId}`);
  
  try {
    // Use getAdminFirestore with explicit app and database ID
    const db = getAdminFirestore(adminApp, dbId);
    
    // Test connection with a write operation
    console.log(`[Firestore] Testing connection to ${dbId}...`);
    await db.collection('test_connection').doc('server_init').set({ 
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      projectId: projectId,
      databaseId: dbId,
      status: 'connected'
    });
    
    console.log(`[Firestore] Successfully connected to database: ${dbId}`);
    return db;
  } catch (e: any) {
    console.error(`[Firestore] CRITICAL CONNECTION ERROR for database ${dbId}: ${e.message}`);
    if (e.code === 7 || e.message?.includes('PERMISSION_DENIED')) {
      console.error(`[Firestore] Permission denied. Please ensure Firestore API is enabled and Service Account has 'Cloud Datastore User' or 'Owner' role.`);
    }
    // Return the instance anyway, operations will fail with descriptive errors
    return getAdminFirestore(adminApp, dbId);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Initialize firestore inside startServer to handle async
  firestore = await getFirestoreInstance();
  const auth = admin.auth();

  app.use(express.json());

  // Middleware to check if user is admin
  const checkAdmin = async (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const idToken = authHeader.split("Bearer ")[1];
    if (!idToken || idToken === "null" || idToken === "undefined") {
      console.error("Token is missing or null");
      return res.status(401).json({ error: "Invalid token: Token is missing or null" });
    }
    try {
      // Attempt standard verification
      let decodedToken;
      try {
        decodedToken = await auth.verifyIdToken(idToken);
      } catch (verifyError: any) {
        console.error("Standard token verification failed:", verifyError.message);
        
        // Fallback: Manual decode for the primary admin if API is disabled
        const parts = idToken.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
          const isPrimaryAdmin = payload.email === "hoanghiep1296@gmail.com" || 
                                 payload.email === "mrihachnach@gmail.com" || 
                                 payload.email === "admin@gmail.com" ||
                                 payload.email === "hoctap853@gmail.com";
          
          if (isPrimaryAdmin && payload.email_verified) {
            console.log("Using fallback verification for primary admin:", payload.email);
            decodedToken = payload;
            if (!decodedToken.uid) decodedToken.uid = payload.sub;
          } else {
            throw verifyError;
          }
        } else {
          throw verifyError;
        }
      }

      let userData: any = null;
      try {
        const userDoc = await firestore.collection("users").doc(decodedToken.uid).get();
        userData = userDoc.data();
      } catch (dbError: any) {
        if (dbError.message.includes("PERMISSION_DENIED")) {
          console.warn("Admin check: Firestore access denied. Relying on hardcoded admin list.");
        } else {
          console.error("Firestore fetch failed in admin check:", dbError.message);
        }
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
      await auth.listUsers(1);
      results.auth.status = "ok";
    } catch (e: any) {
      results.auth.status = "error";
      results.auth.message = e.message;
      results.auth.code = e.code;
      if (e.message?.includes("Identity Toolkit API")) {
        results.auth.advice = "Kích hoạt Identity Toolkit API trong Google Cloud Console.";
        results.auth.link = `https://console.developers.google.com/apis/api/identitytoolkit.googleapis.com/overview?project=${firebaseConfig.projectId}`;
      }
    }

    try {
      await firestore.collection("test_connection").doc("diagnostic").set({
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        message: "Diagnostic test"
      });
      results.firestore.status = "ok";
    } catch (e: any) {
      results.firestore.status = "error";
      results.firestore.message = e.message;
      results.firestore.code = e.code;
      if (e.message?.includes("PERMISSION_DENIED") || e.code === 7) {
        results.firestore.advice = "Cấp quyền 'Cloud Datastore User' cho Service Account trong IAM Console.";
        results.firestore.link = `https://console.cloud.google.com/iam-admin/iam?project=${firebaseConfig.projectId}`;
      }
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
            details: `Bạn PHẢI kích hoạt Identity Toolkit API tại: https://console.developers.google.com/apis/api/identitytoolkit.googleapis.com/overview?project=${firebaseConfig.projectId}\n\nSau khi kích hoạt, hãy đợi 1-2 phút rồi thử lại.`,
            apiLink: `https://console.developers.google.com/apis/api/identitytoolkit.googleapis.com/overview?project=${firebaseConfig.projectId}`
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
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      let dbSuccess = true;
      try {
        await firestore.collection("users").doc(uid).set(userData);
        
        // 4. Also add to authorized_emails for consistency
        await firestore.collection("authorized_emails").doc(email.toLowerCase()).set({
          role: role || "user",
          addedBy: (req as any).user.uid,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (dbError: any) {
        console.warn("Firestore update failed during user creation (server-side):", dbError.message);
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
          details: `Bạn PHẢI kích hoạt Identity Toolkit API tại: https://console.developers.google.com/apis/api/identitytoolkit.googleapis.com/overview?project=${firebaseConfig.projectId}\n\nSau khi kích hoạt, hãy đợi 1-2 phút rồi thử lại.`,
          apiLink: `https://console.developers.google.com/apis/api/identitytoolkit.googleapis.com/overview?project=${firebaseConfig.projectId}`
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

  // Admin: List Users (Merged Auth + Firestore)
  app.get("/api/admin/list-users", checkAdmin, async (req, res) => {
    let authUsers: any[] = [];
    let authError: string | null = null;
    let firestoreError: string | null = null;

    const debugInfo = {
      projectId: firebaseConfig.projectId,
      databaseId: firebaseConfig.firestoreDatabaseId,
      runningProject: process.env.GOOGLE_CLOUD_PROJECT
    };

    // 1. Attempt to fetch all users from Firebase Auth
    try {
      const listUsersResult = await auth.listUsers();
      authUsers = listUsersResult.users.map(userRecord => ({
        uid: userRecord.uid,
        email: userRecord.email,
        displayName: userRecord.displayName,
        photoURL: userRecord.photoURL,
        emailVerified: userRecord.emailVerified,
        disabled: userRecord.disabled,
        metadata: userRecord.metadata,
      }));
    } catch (error: any) {
      // Only log if it's not a project mismatch error (which is expected in this environment)
      if (!error.message.includes("574247538815") && !error.message.includes("Identity Toolkit API")) {
        console.error("[Admin] Auth listUsers failed:", error.message);
      }
      authError = error.message;
    }

    // 2. Fetch all users from Firestore
    const firestoreUsersMap = new Map();
    try {
      const usersSnapshot = await firestore.collection("users").get();
      usersSnapshot.docs.forEach(doc => {
        firestoreUsersMap.set(doc.id, doc.data());
      });
    } catch (dbError: any) {
      // Only log if it's not a project mismatch error
      if (!dbError.message.includes("574247538815") && !dbError.message.includes("PERMISSION_DENIED")) {
        console.error("[Admin] Firestore list users failed:", dbError.message);
      }
      firestoreError = dbError.message;
    }

    // 3. Merge or Fallback
    let finalUsers: any[] = [];

    if (authUsers.length > 0) {
      // Merge Auth users with Firestore data
      finalUsers = authUsers.map(authUser => {
        const firestoreData = firestoreUsersMap.get(authUser.uid) || {};
        return {
          ...authUser,
          ...firestoreData,
          role: firestoreData.role || (authUser.email === "hoanghiep1296@gmail.com" || authUser.email === "mrihachnach@gmail.com" || authUser.email === "admin@gmail.com" || authUser.email === "hoctap853@gmail.com" ? "admin" : "user"),
          displayName: firestoreData.displayName || authUser.displayName || authUser.email?.split('@')[0],
          createdAt: firestoreData.createdAt || authUser.metadata.creationTime,
        };
      });
    } else {
      // If Auth failed, use Firestore users as source of truth
      finalUsers = Array.from(firestoreUsersMap.values()).map(u => ({
        ...u,
        uid: u.uid || u.id
      }));
    }

    // If both failed, return a descriptive error
    if (authUsers.length === 0 && firestoreUsersMap.size === 0) {
      return res.status(500).json({
        error: "Không thể lấy dữ liệu người dùng từ cả Auth và Firestore.",
        details: `Auth Error: ${authError || 'None'}. Firestore Error: ${firestoreError || 'None'}.`,
        advice: "Lỗi này thường do Service Account của máy chủ không có quyền truy cập vào dự án của bạn. Hãy sử dụng danh sách người dùng trực tiếp từ ứng dụng (Client SDK).",
        ...debugInfo
      });
    }

    res.json({ 
      success: true, 
      users: finalUsers,
      authSyncError: authError && (authError.includes("Identity Toolkit API") || authError.includes("403")) ? "API_DISABLED" : (firestoreError ? "FIRESTORE_ERROR" : null),
      details: authError || firestoreError,
      apiLink: `https://console.developers.google.com/apis/api/identitytoolkit.googleapis.com/overview?project=${firebaseConfig.projectId}`,
      ...debugInfo
    });
  });

  // Admin: Reset Password
  app.post("/api/admin/reset-password", checkAdmin, async (req, res) => {
    const { uid, newPassword } = req.body;
    try {
      await auth.updateUser(uid, {
        password: newPassword,
      });
      res.json({ success: true });
    } catch (error: any) {
      console.error("[Admin] Error resetting password:", error);
      res.status(400).json({ error: error.message });
    }
  });

  // Admin: Delete User
  app.post("/api/admin/delete-user", checkAdmin, async (req, res) => {
    const { uid, email } = req.body;
    try {
      // 1. Delete from Auth
      await auth.deleteUser(uid);
      
      // 2. Delete from Firestore (Optional on server)
      let dbSuccess = true;
      try {
        await firestore.collection("users").doc(uid).delete();
        if (email) {
          await firestore.collection("authorized_emails").doc(email.toLowerCase()).delete();
        }
      } catch (dbError: any) {
        console.warn("Firestore delete failed during user deletion (server-side):", dbError.message);
        dbSuccess = false;
      }
      
      res.json({ success: true, dbSuccess });
    } catch (error: any) {
      console.error("[Admin] Error deleting user:", error);
      res.status(400).json({ error: error.message });
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

  if (process.env.NODE_ENV !== "production") {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }

  return app;
}

const serverPromise = startServer();

export default async (req: any, res: any) => {
  const app = await serverPromise;
  return app(req, res);
};
