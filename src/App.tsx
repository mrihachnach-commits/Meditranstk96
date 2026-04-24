/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { MedicalDictionary } from './components/MedicalDictionary';

import { Logo, LogoWithText } from './components/Logo';

import { FileExplorer, FileData } from './components/FileExplorer';
import { UploadStatus, UploadTask } from './components/UploadStatus';

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js`;

import { 
  Upload, 
  FileText, 
  ChevronLeft, 
  ChevronRight, 
  Settings, 
  Loader2, 
  Download, 
  Languages,
  AlertCircle,
  CheckCircle2,
  Maximize2,
  Minimize2,
  Search,
  Hand,
  Trash2,
  RefreshCcw,
  KeyRound,
  Layout,
  ArrowLeft,
  ZoomIn,
  ZoomOut,
  Maximize,
  Type,
  ALargeSmall,
  Type as FontIcon,
  LogIn,
  LogOut,
  Plus,
  Key,
  Activity,
  Zap,
  ShieldCheck,
  ShieldAlert,
  User as UserIcon,
  UserPlus,
  Users,
  X,
  Square,
  Check,
  Copy,
  Folder,
  Home,
  ExternalLink,
  Mail,
  Eye,
  EyeOff,
  Save,
  ScrollText,
  FileSearch,
  BookOpen
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { saveAs } from 'file-saver';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { GeminiService } from './services/geminiService';
import { MedicalApiService } from './services/medicalApiService';
import { TranslationEngine, TranslationService } from './services/translationService';
import { 
  auth, 
  firebaseConfig,
  signOut, 
  onAuthStateChanged, 
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
  db, 
  collection, 
  addDoc,
  doc, 
  setDoc, 
  getDoc, 
  getDocs, 
  query, 
  where, 
  orderBy,
  onSnapshot, 
  deleteDoc, 
  updateDoc, 
  serverTimestamp,
  User,
  Timestamp,
  getDocFromServer,
  OperationType,
  handleFirestoreError
} from './firebase';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let errorMessage = "Đã có lỗi xảy ra. Vui lòng tải lại trang.";
      try {
        if (this.state.error?.message.startsWith('{')) {
          const info = JSON.parse(this.state.error.message);
          errorMessage = `Lỗi hệ thống (${info.operationType}): ${info.error}`;
        }
      } catch (e) {}

      return (
        <div className="h-screen flex flex-col items-center justify-center bg-slate-50 p-8 text-center">
          <div className="bg-white p-8 rounded-3xl shadow-xl border border-slate-100 max-w-md">
            <AlertCircle className="w-16 h-16 text-rose-500 mx-auto mb-6" />
            <h2 className="text-2xl font-display font-bold text-slate-800 mb-4">Rất tiếc!</h2>
            <p className="text-slate-500 mb-8">{errorMessage}</p>
            <button 
              onClick={() => window.location.reload()}
              className="w-full py-4 bg-indigo-600 text-white rounded-full font-bold shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition-all active:scale-95"
            >
              Tải lại trang
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface TranslationState {
  [page: number]: {
    content: string;
    status: 'idle' | 'loading' | 'success' | 'error';
  };
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [currentFileName, setCurrentFileName] = useState<string>('');
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [currentJob, setCurrentJob] = useState(1);
  const PAGES_PER_JOB = 100;
  const totalJobs = Math.ceil(numPages / PAGES_PER_JOB);

  const [fileId, setFileId] = useState<string | null>(null);
  const [showExplorer, setShowExplorer] = useState(true);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [translations, setTranslations] = useState<TranslationState>({});
  const translationsRef = useRef<TranslationState>({});
  const currentPageRef = useRef<number>(1);
  const [activeTranslation, setActiveTranslation] = useState<{page: number, content: string, status: string} | null>(null);
  const translatingPagesRef = useRef<Set<number>>(new Set());
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileIdRef = useRef<number>(0);
  const preTranslateControllersRef = useRef<Map<number, AbortController>>(new Map());

  useEffect(() => {
    translationsRef.current = translations;
  }, [translations]);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  // Sync currentJob with currentPage (Virtual Job)
  useEffect(() => {
    if (numPages > 0) {
      const newJob = Math.ceil(currentPage / PAGES_PER_JOB);
      if (newJob !== currentJob) {
        setCurrentJob(newJob);
      }
    }
  }, [currentPage, numPages, currentJob]);

  const [isTranslating, setIsTranslating] = useState(false);
  const isTranslatingRef = useRef(false);
  useEffect(() => {
    isTranslatingRef.current = isTranslating;
  }, [isTranslating]);
  const selectedEngine: TranslationEngine = 'gemini-flash';
  
  const [engineKeys, setEngineKeys] = useState<Record<TranslationEngine, string>>(() => {
    const saved = localStorage.getItem('engine_keys');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error("Failed to parse engine keys:", e);
      }
    }
    
    // Initial defaults
    const envKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    const fallbackKey = "AIzaSyAafP-Y07NOB01sVKhK_3h6c28oY33Q_JE";
    const defaultKey = (envKey && envKey.trim() !== "" && envKey !== "MY_GEMINI_API_KEY") ? envKey : fallbackKey;
    
    return {
      'gemini-flash': defaultKey,
      'gemini-pro': defaultKey,
      'medical-specialized': ''
    };
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [selectedPagesToDownload, setSelectedPagesToDownload] = useState<number[]>([]);
  const [hasEnvKey, setHasEnvKey] = useState(false);
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const [isLocalOnly, setIsLocalOnly] = useState(false);
  const [showFolderSelectModal, setShowFolderSelectModal] = useState(false);
  const [allFolders, setAllFolders] = useState<{id: string, name: string, parentId?: string | null}[]>([]);
  const [isFirebaseConnected, setIsFirebaseConnected] = useState<boolean | null>(null);
  const [toast, setToast] = useState<{message: string, type: 'success' | 'error' | 'info'} | null>(null);
  
  // Summarization State
  const [translationPanelMode, setTranslationPanelMode] = useState<'translation' | 'summary'>('translation');
  const [summaryText, setSummaryText] = useState<string>('');
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isSavingSummary, setIsSavingSummary] = useState(false);
  const [summaryRange, setSummaryRange] = useState<{from: number, to: number}>({from: 1, to: 1});
  const summarySignalRef = useRef<AbortController | null>(null);

  // Initialize summary range when numPages changes
  useEffect(() => {
    if (numPages > 0) {
      setSummaryRange(prev => ({ ...prev, to: Math.min(numPages, prev.from + 4) }));
    }
  }, [numPages]);

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Test Firebase connection
  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
        setIsFirebaseConnected(true);
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
          setIsFirebaseConnected(false);
        }
        // Skip logging for other errors, as this is simply a connection test.
      }
    }
    testConnection();
  }, []);

  // Sync folders for late upload selection
  useEffect(() => {
    if (!user) {
      setAllFolders([]);
      return;
    }

    const q = query(collection(db, `users/${user.uid}/folders`), orderBy('name'));
    return onSnapshot(q, (snapshot) => {
      const folderList = snapshot.docs.map(doc => ({
        id: doc.id,
        name: doc.data().name,
        parentId: doc.data().parentId
      }));
      setAllFolders(folderList);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}/folders`);
    });
  }, [user]);

  // Helper to get full folder path
  const getFolderPath = (folderId: string | null): string => {
    if (!folderId) return 'Root';
    const folder = allFolders.find(f => f.id === folderId);
    if (!folder) return 'Unknown';
    
    const path = [folder.name];
    let currentParentId = folder.parentId;
    
    // Guard against circular refs or too deep structure
    let depth = 0;
    while (currentParentId && depth < 20) {
      const parent = allFolders.find(f => f.id === currentParentId);
      if (parent) {
        path.unshift(parent.name);
        currentParentId = parent.parentId;
      } else {
        break;
      }
      depth++;
    }
    
    return path.join(' / ');
  };

  const handleLocalFileOpen = async (localFile: File) => {
    setIsPdfLoading(true);
    setPdfError(null);
    setShowExplorer(false);
    setIsLocalOnly(true);
    setCurrentFileName(localFile.name);
    
    // On mobile, switch to split view automatically when opening a file
    if (window.innerWidth < 768) {
      setMobileViewMode('split');
    }
    
    // Generate a temporary docId for local file
    const docId = `local_${localFile.name.replace(/[^a-zA-Z0-9]/g, '_')}_${localFile.size}`;
    setFileId(docId);

    // Increment fileId to invalidate all pending translations
    fileIdRef.current += 1;
    
    // Abort all pending translations
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    
    preTranslateControllersRef.current.forEach(controller => controller.abort());
    preTranslateControllersRef.current.clear();
    translatingPagesRef.current.clear();

    setFile(localFile);
    setTranslations({});
    setCurrentPage(1);
    setCurrentJob(1);
    setAutoTranslate(false);

    try {
      if (fileUrl) URL.revokeObjectURL(fileUrl);
      const url = URL.createObjectURL(localFile);
      setFileUrl(url);
      
      console.log(`[MediTrans AI] Loading local PDF: ${localFile.name}`);

      const loadingTask = pdfjs.getDocument({
        url,
        cMapUrl: `https://unpkg.com/pdfjs-dist@3.11.174/cmaps/`,
        cMapPacked: true,
        disableAutoFetch: false,
        disableStream: false,
      });

      const pdf = await loadingTask.promise;
      setPdfDoc(pdf);
      setNumPages(pdf.numPages);
    } catch (error: any) {
      console.error("Error loading local PDF:", error);
      setPdfError(`Không thể tải file PDF cục bộ: ${error.message || "Lỗi không xác định"}`);
    } finally {
      setIsPdfLoading(false);
    }
  };

  const startUpload = async (fileToUpload: File, folderId: string | null) => {
    const user = auth.currentUser;
    if (!user) return;

    const taskId = Math.random().toString(36).substring(7);
    const newTask: UploadTask = {
      id: taskId,
      fileName: fileToUpload.name,
      status: 'uploading',
      progress: 0
    };

    setUploadTasks(prev => [newTask, ...prev]);

    try {
      const formData = new FormData();
      formData.append('file', fileToUpload);

      // Retry logic for 100% success rate
      let response;
      let retries = 3;
      let delay = 1000;

      while (retries > 0) {
        try {
          response = await fetch('/api/tinyvault', {
            method: 'POST',
            body: formData
          });
          if (response.ok) break;
          
          // If 5xx or 429, retry
          if (response.status >= 500 || response.status === 429) {
            retries--;
            if (retries > 0) {
              await new Promise(resolve => setTimeout(resolve, delay));
              delay *= 2; // Exponential backoff
              continue;
            }
          }
          break; // Other errors don't retry
        } catch (e) {
          retries--;
          if (retries === 0) throw e;
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
        }
      }

      if (!response || !response.ok) {
        const errorData = response ? await response.json().catch(() => ({})) : {};
        console.error("Upload failed after retries:", errorData);
        throw new Error(errorData.details || errorData.error || `Upload failed with status ${response?.status || 'unknown'}`);
      }

      const data = await response.json();
      
      if (data.token) {
        try {
          await addDoc(collection(db, `users/${user.uid}/documents`), {
            name: fileToUpload.name,
            folderId: folderId,
            token: data.token,
            downloadUrl: data.download_url,
            size: fileToUpload.size,
            type: fileToUpload.type,
            createdAt: serverTimestamp()
          });
        } catch (error) {
          handleFirestoreError(error, OperationType.CREATE, `users/${user.uid}/documents`);
        }

        setIsLocalOnly(false);
        setShowFolderSelectModal(false);

        setUploadTasks(prev => prev.map(t => 
          t.id === taskId ? { ...t, status: 'success' } : t
        ));

        // Auto dismiss success after 5 seconds
        setTimeout(() => {
          setUploadTasks(prev => prev.filter(t => t.id !== taskId));
        }, 5000);
      } else {
        throw new Error("Upload failed");
      }
    } catch (error) {
      console.error("Error uploading file:", error);
      setUploadTasks(prev => prev.map(t => 
        t.id === taskId ? { ...t, status: 'error' } : t
      ));
    }
  };

  const dismissUploadTask = (id: string) => {
    setUploadTasks(prev => prev.filter(t => t.id !== id));
  };

  useEffect(() => {
    const checkKey = async () => {
      if (translationService.current) {
        const hasKey = await translationService.current.hasApiKey();
        setHasEnvKey(hasKey);
      }
    };
    checkKey();
  }, [selectedEngine, engineKeys]);

  const [isFullScreen, setIsFullScreen] = useState(false);
  const isFullScreenRef = useRef(false);

  const toggleFullScreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        }
      }
    } catch (err) {
      console.error(`Error attempting to enable full-screen mode: ${err}`);
      // Fallback to internal state if native fails (e.g. in some iframe environments)
      setIsFullScreen(!isFullScreen);
    }
  };

  useEffect(() => {
    const handleFullScreenChange = () => {
      const isNativeFull = !!document.fullscreenElement;
      setIsFullScreen(isNativeFull);
      isFullScreenRef.current = isNativeFull;
      if (isNativeFull) setSelectedTerm(null);
    };

    document.addEventListener('fullscreenchange', handleFullScreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullScreenChange);
  }, []);
  const [showTranslationPanel, setShowTranslationPanel] = useState(false);
  const [mobileViewMode, setMobileViewMode] = useState<'pdf' | 'translation' | 'split'>('pdf');
  const [autoTranslate, setAutoTranslate] = useState(false);
  const [autoTranslateLookAhead, setAutoTranslateLookAhead] = useState(2);
  const [zoom, setZoom] = useState(0.82); // Default to 82% as requested
  const [isAutoFit, setIsAutoFit] = useState(true);
  
  const [isPanning, setIsPanning] = useState(false);
  const [isLookupEnabled, setIsLookupEnabled] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });

  const [isPdfLoading, setIsPdfLoading] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const isRenderingRef = useRef(false);
  const renderRequestIdRef = useRef(0);
  const [pdfError, setPdfError] = useState<string | null>(null);
  
  const [fontSize, setFontSize] = useState(14);
  const [fontFamily, setFontFamily] = useState('Inter');
  
  // PDF Rendering Cache to prevent re-loading same pages during navigation
  const pageCacheRef = useRef<Map<number, { canvas: HTMLCanvasElement, zoom: number, textContent: any }>>(new Map());
  const CACHE_SIZE_LIMIT = 8; // Keep last 8 pages in memory for instant switching

  const [isAuthReady, setIsAuthReady] = useState(false);
  const [userRole, setUserRole] = useState<'admin' | 'user' | null>(null);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [authSyncError, setAuthSyncError] = useState<string | null>(null);
  const [apiActivationLink, setApiActivationLink] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeDatabaseId, setActiveDatabaseId] = useState<string | null>(null);
  const [isFetchingUsers, setIsFetchingUsers] = useState(false);
  const [adminUserSearch, setAdminUserSearch] = useState('');
  const [adminRoleFilter, setAdminRoleFilter] = useState<'all' | 'user' | 'admin' | 'blocked'>('all');
  const [adminNewUserEmail, setAdminNewUserEmail] = useState('');
  const [adminNewUserPassword, setAdminNewUserPassword] = useState('');
  const [adminNewUserDisplayName, setAdminNewUserDisplayName] = useState('');
  const [adminNewUserRole, setAdminNewUserRole] = useState<'user' | 'admin'>('user');
  const [isCreatingUser, setIsCreatingUser] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [newPasswordValue, setNewPasswordValue] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authDisplayName, setAuthDisplayName] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [showAuthPassword, setShowAuthPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showAdminNewUserPassword, setShowAdminNewUserPassword] = useState(false);
  const [showApiKeys, setShowApiKeys] = useState(false);

  const [userKeys, setUserKeys] = useState<any[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [isAddingKey, setIsAddingKey] = useState(false);
  const [newKey, setNewKey] = useState({ name: '', value: '', engine: 'gemini' });
  const [keyToDelete, setKeyToDelete] = useState<any | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [keyCheckResults, setKeyCheckResults] = useState<{ 
    envKey: boolean; 
    manualKey: boolean; 
    envKeyName?: string;
    isVaultKey?: boolean;
    vaultKeyName?: string;
    totalActive?: number;
    totalChecked?: number;
  } | null>(null);
  const [isCheckingKeys, setIsCheckingKeys] = useState(false);

  const [hasDoneInitialCheck, setHasDoneInitialCheck] = useState(false);

  const performKeyCheck = async (silent: boolean = false) => {
    if (!silent) setIsCheckingKeys(true);
    try {
      // 1. Check System/Environment Key
      const envKey = engineKeys[selectedEngine];
      const testService = new GeminiService(envKey, "gemini-3.1-flash-lite-preview");
      const envResults = await testService.checkAvailableKeys();
      
      // 2. Check ALL Vault Keys in parallel for better performance
      let activeVaultCount = 0;
      let currentVaultKeyResults = null;

      if (user && userKeys.length > 0) {
        const currentEngineType = selectedEngine.startsWith('gemini') ? 'gemini' : selectedEngine;
        const vaultKeysToCheck = userKeys.filter(k => k.engine === currentEngineType);
        
        // Run checks in parallel
        const checkPromises = vaultKeysToCheck.map(async (vKey) => {
          const vService = new GeminiService(vKey.value, "gemini-3.1-flash-lite-preview");
          const vRes = await vService.checkAvailableKeys();
          const isActive = vRes.manualKey;
          
          if (isActive) activeVaultCount++;
          
          // Update Firestore for each key
          try {
            await updateDoc(doc(db, 'apiKeys', vKey.id), {
              lastUsed: serverTimestamp(),
              status: isActive ? 'active' : 'error'
            });
          } catch (e) {
            handleFirestoreError(e, OperationType.UPDATE, `apiKeys/${vKey.id}`);
          }
          
          // If this is the currently selected key, store its result for the notification
          if (vKey.id === selectedKeyId) {
            currentVaultKeyResults = {
              isActive,
              name: vKey.name
            };
          }
          
          return { id: vKey.id, isActive };
        });

        await Promise.all(checkPromises);
      }

      // 3. Set results for UI only if not silent
      if (!silent) {
        setKeyCheckResults({
          envKey: envResults.envKey,
          manualKey: currentVaultKeyResults ? currentVaultKeyResults.isActive : false,
          envKeyName: "Hệ thống (Environment)",
          isVaultKey: !!currentVaultKeyResults,
          vaultKeyName: currentVaultKeyResults?.name || '',
          totalActive: (envResults.envKey ? 1 : 0) + activeVaultCount,
          totalChecked: 1 + (userKeys.filter(k => k.engine === (selectedEngine.startsWith('gemini') ? 'gemini' : selectedEngine)).length)
        });
        
        // Auto-hide after 10 seconds
        setTimeout(() => setKeyCheckResults(null), 10000);
      }
      
      setHasDoneInitialCheck(true);
    } catch (e) {
      console.error("Key check failed:", e);
    } finally {
      if (!silent) setIsCheckingKeys(false);
    }
  };

  useEffect(() => {
    const testConnection = async () => {
      try {
        const { doc, setDoc, serverTimestamp } = await import('firebase/firestore');
        await setDoc(doc(db, 'test_connection', 'client_boot'), {
          timestamp: serverTimestamp(),
          message: 'Client started and connected'
        });
        console.log('Firestore client connection test SUCCESSFUL');
      } catch (error: any) {
        console.error('Firestore client connection test FAILED:', error.message);
      }
    };
    testConnection();
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
      
      if (currentUser) {
        // Ensure user profile exists in Firestore
        const path = `users/${currentUser.uid}`;
        try {
          const userRef = doc(db, 'users', currentUser.uid);
          const userSnap = await getDoc(userRef);
          
          // CRITICAL: Always check if this specific email should be admin
          const isAdminEmail = currentUser.email?.toLowerCase() === "hoanghiep1296@gmail.com" || 
                               currentUser.email?.toLowerCase() === "mrihachnach@gmail.com" || 
                               currentUser.email?.toLowerCase() === "admin@gmail.com" || 
                               currentUser.email?.toLowerCase() === "hoctap853@gmail.com";
          
          if (!userSnap.exists()) {
            try {
              await setDoc(userRef, {
                uid: currentUser.uid,
                email: currentUser.email,
                displayName: currentUser.displayName,
                photoURL: currentUser.photoURL,
                createdAt: serverTimestamp(),
                role: isAdminEmail ? 'admin' : 'user',
                isBlocked: false
              }, { merge: true });
            } catch (writeError) {
              console.warn("Failed to create user doc:", writeError);
            }
            setUserRole(isAdminEmail ? 'admin' : 'user');
          } else {
            const data = userSnap.data();
            
            // Check if user is blocked
            if (data?.isBlocked && !isAdminEmail) {
              console.warn("User is blocked, logging out...");
              showToast("Tài khoản của bạn đã bị khóa bởi quản trị viên.", 'error');
              await signOut(auth);
              setUser(null);
              setIsAuthReady(true);
              return;
            }

            let currentRole = data?.role || 'user';
            // If it's an admin email but role is not admin, update it
            if (isAdminEmail && currentRole !== 'admin') {
              try {
                await updateDoc(userRef, { role: 'admin' });
              } catch (updateError) {
                console.warn("Failed to update admin role in DB:", updateError);
              }
              setUserRole('admin');
            } else {
              setUserRole(currentRole);
            }
          }
        } catch (error: any) {
          console.error("Error fetching user data from Firestore:", error);
          
          // Fallback if Firestore is completely blocked
          const isAdminEmail = currentUser.email?.toLowerCase() === "hoanghiep1296@gmail.com" || 
                               currentUser.email?.toLowerCase() === "mrihachnach@gmail.com" || 
                               currentUser.email?.toLowerCase() === "admin@gmail.com" || 
                               currentUser.email?.toLowerCase() === "hoctap853@gmail.com";
          if (isAdminEmail) {
            setUserRole('admin');
          } else {
            setUserRole('user');
          }
          
          // Only show error if it's not a common permission issue during setup
          if (!error.message?.includes('permission-denied')) {
            handleFirestoreError(error, OperationType.WRITE, path);
          }
        }
      } else {
        setUserRole(null);
        setShowAdminPanel(false);
      }
    });
    return () => unsubscribe();
  }, []);

  // Real-time security listener: Force logout if blocked
  useEffect(() => {
    if (!user) return;

    // Listen to user's own document
    const userDocRef = doc(db, 'users', user.uid);
    const unsubscribeUser = onSnapshot(userDocRef, async (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        
        // CRITICAL: Admins are immune to blocking to prevent accidental lockout
        const isAdminEmail = user.email?.toLowerCase() === "hoanghiep1296@gmail.com" || 
                             user.email?.toLowerCase() === "mrihachnach@gmail.com" || 
                             user.email?.toLowerCase() === "admin@gmail.com" || 
                             user.email?.toLowerCase() === "hoctap853@gmail.com";

        if (data?.isBlocked && !isAdminEmail) {
          console.warn("User has been blocked remotely. Logging out...");
          showToast("Tài khoản của bạn đã bị khóa bởi quản trị viên.", 'error');
          await signOut(auth);
          return;
        }

        if (data?.role !== userRole && userRole !== null) {
          setUserRole(data?.role || 'user');
        }
      }
    });

    return () => {
      unsubscribeUser();
    };
  }, [user, userRole]);

  // Perform key check when user logs in and keys are loaded
  useEffect(() => {
    if (user && isAuthReady && !hasDoneInitialCheck) {
      // Automatic key check disabled to save quota as requested by user
      setHasDoneInitialCheck(true);
    }
  }, [user, isAuthReady, hasDoneInitialCheck]);

  useEffect(() => {
    if (user) {
      const path = 'apiKeys';
      const q = query(collection(db, 'apiKeys'), where('ownerId', '==', user.uid));
      const unsubscribe = onSnapshot(q, (snapshot) => {
        const keys = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setUserKeys(keys);
        
        // Auto-select first key if none selected
        if (keys.length > 0 && !selectedKeyId) {
          setSelectedKeyId(keys[0].id);
        }
      }, (error) => {
        handleFirestoreError(error, OperationType.GET, path);
      });
      return () => unsubscribe();
    } else {
      setUserKeys([]);
      setSelectedKeyId(null);
    }
  }, [user]);

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    setAuthError(null);

    try {
      if (authMode === 'register') {
        setAuthError("Đăng ký đã bị vô hiệu hóa. Vui lòng liên hệ quản trị viên.");
        setIsLoggingIn(false);
        return;
      } else {
        await signInWithEmailAndPassword(auth, authEmail, authPassword);
      }
      setShowAuthModal(false);
      setAuthEmail('');
      setAuthPassword('');
      setAuthDisplayName('');
    } catch (error: any) {
      console.error("Email auth failed:", error);
      if (error.code === 'auth/email-already-in-use') {
        setAuthError("Email này đã được sử dụng.");
      } else if (error.code === 'auth/invalid-credential') {
        setAuthError("Email hoặc mật khẩu không chính xác.");
      } else if (error.code === 'auth/weak-password') {
        setAuthError("Mật khẩu quá yếu (tối thiểu 6 ký tự).");
      } else {
        setAuthError("Xác thực thất bại. Vui lòng kiểm tra lại thông tin.");
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  const handleAddKey = async () => {
    if (!user || !newKey.name || !newKey.value) return;
    const path = 'apiKeys';
    try {
      await setDoc(doc(collection(db, 'apiKeys')), {
        ownerId: user.uid,
        name: newKey.name,
        value: newKey.value,
        engine: newKey.engine,
        createdAt: serverTimestamp(),
        lastUsed: serverTimestamp()
      });
      setNewKey({ name: '', value: '', engine: 'gemini' });
      setIsAddingKey(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  };

  const handleDeleteKey = async (keyId: string) => {
    const path = `apiKeys/${keyId}`;
    try {
      await deleteDoc(doc(db, 'apiKeys', keyId));
      if (selectedKeyId === keyId) setSelectedKeyId(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  };

  const [isDiagnosticModalOpen, setIsDiagnosticModalOpen] = useState(false);
  const [diagnosticResults, setDiagnosticResults] = useState<any>(null);
  const [isRunningDiagnostics, setIsRunningDiagnostics] = useState(false);

  const runDiagnostics = async () => {
    setIsRunningDiagnostics(true);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      const response = await fetch("/api/admin/diagnostics", {
        headers: {
          'Authorization': `Bearer ${idToken}`
        }
      });
      const data = await response.json();
      setDiagnosticResults(data);
      setIsDiagnosticModalOpen(true);
    } catch (error: any) {
      console.error("Diagnostics failed:", error);
      showToast("Không thể chạy chẩn đoán: " + error.message, 'error');
    } finally {
      setIsRunningDiagnostics(false);
    }
  };

  const fetchAllUsers = async () => {
    if (userRole !== 'admin' || !user) return;
    setIsFetchingUsers(true);
    
    // 1. First, fetch directly from Firestore (Client SDK)
    // This is more reliable in this environment because it uses the user's own authorized token
    try {
      const querySnapshot = await getDocs(collection(db, 'users'));
      const users = querySnapshot.docs.map(doc => ({
        ...doc.data(),
        uid: doc.id
      }));
      
      // Sort by createdAt (newest first)
      const sortedUsers = users.sort((a: any, b: any) => {
        const getTime = (val: any) => {
          if (!val) return 0;
          if (typeof val.toDate === 'function') return val.toDate().getTime();
          if (val._seconds) return val._seconds * 1000;
          const date = new Date(val);
          return isNaN(date.getTime()) ? 0 : date.getTime();
        };
        return getTime(b.createdAt) - getTime(a.createdAt);
      });
      
      setAllUsers(sortedUsers);
      
      // 2. Then, try to enrich with Auth data from Admin API (optional)
      try {
        const token = await user.getIdToken();
        const response = await fetch('/api/admin/list-users', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.users) {
            setAuthSyncError(data.authSyncError || null);
            setApiActivationLink(data.apiLink || null);
            
            // Merge Auth data (like emailVerified) into our Firestore list
            setAllUsers(prev => prev.map(u => {
              const authUser = data.users.find((au: any) => au.uid === u.uid);
              return authUser ? { ...u, ...authUser } : u;
            }));
          }
        }
      } catch (adminError) {
        console.warn("Admin API enrichment failed (expected if API/Permissions not set):", adminError);
      }
    } catch (e: any) {
      console.error("Failed to fetch users from Firestore:", e);
      handleFirestoreError(e, OperationType.LIST, 'users');
    } finally {
      setIsFetchingUsers(false);
    }
  };

  const createNewUser = async (userData: any) => {
    if (userRole !== 'admin' || !user) {
      throw new Error("Bạn không có quyền thực hiện hành động này");
    }
    
    // Basic validation
    if (!userData.email || !userData.email.includes('@')) {
      throw new Error("Email không hợp lệ");
    }
    if (!userData.password || userData.password.length < 6) {
      throw new Error("Mật khẩu phải có ít nhất 6 ký tự");
    }

    try {
      const token = await user.getIdToken();
      const response = await fetch('/api/admin/create-user', {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(userData)
      });
      
      const data = await response.json();
      
      if (response.ok && data.success) {
        // If server-side DB write failed, try from client (Admin has permission)
        if (!data.dbSuccess && data.userData) {
          console.log("Server-side DB write failed, retrying from client...");
          try {
            const uid = data.uid;
            const email = data.userData.email;
            
            await setDoc(doc(db, 'users', uid), {
              ...data.userData,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
            
            console.log("Client-side DB write successful");
          } catch (clientDbError) {
            console.error("Client-side DB write also failed:", clientDbError);
            // Don't throw here, the user is already created in Auth
          }
        }
        
        await fetchAllUsers();
        return true;
      } else {
        if (data.apiLink) setApiActivationLink(data.apiLink);
        throw new Error(data.details || data.error || "Không thể tạo người dùng");
      }
    } catch (error: any) {
      console.error("Error creating user:", error);
      throw error;
    }
  };

  const toggleBlockUser = async (uid: string, email: string, currentBlocked: boolean) => {
    if (userRole !== 'admin' || !user) return;
    
    // Don't allow blocking admins
    const isAdminEmail = email?.toLowerCase() === "hoanghiep1296@gmail.com" || 
                         email?.toLowerCase() === "mrihachnach@gmail.com" || 
                         email?.toLowerCase() === "admin@gmail.com" || 
                         email?.toLowerCase() === "hoctap853@gmail.com";
    if (isAdminEmail && !currentBlocked) {
      showToast("Không thể chặn tài khoản quản trị viên.", 'error');
      return;
    }

    try {
      await updateDoc(doc(db, 'users', uid), {
        isBlocked: !currentBlocked,
        updatedAt: serverTimestamp()
      });
      
      showToast(currentBlocked ? `Đã khôi phục tài khoản ${email}` : `Đã chặn tài khoản ${email}`, 'success');
      await fetchAllUsers();
    } catch (error: any) {
      console.error("Error toggling block status:", error);
      showToast("Lỗi khi cập nhật trạng thái tài khoản", 'error');
    }
  };

  const resetUserPassword = async (uid: string, newPassword: string) => {
    if (userRole !== 'admin' || !user) return;
    try {
      const token = await user.getIdToken();
      const response = await fetch('/api/admin/reset-password', {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ uid, newPassword })
      });
      const data = await response.json();
      if (data.success) {
        showToast("Đã đổi mật khẩu thành công", 'success');
        return true;
      } else {
        if (data.isApiDisabled) {
          showToast("Lỗi: Identity Toolkit API chưa bật. Hãy thử dùng nút 'Gửi email đặt lại mật khẩu'.", 'error');
        } else {
          showToast(data.error || "Không thể đổi mật khẩu", 'error');
        }
        throw new Error(data.error || "Không thể đổi mật khẩu");
      }
    } catch (error: any) {
      console.error("Error resetting password:", error);
      throw error;
    }
  };

  const sendAdminPasswordResetEmail = async (email: string) => {
    if (userRole !== 'admin') return;
    try {
      const { sendPasswordResetEmail, getAuth } = await import('firebase/auth');
      const authInstance = getAuth();
      await sendPasswordResetEmail(authInstance, email);
      showToast(`Đã gửi email đặt lại mật khẩu tới ${email}`, 'success');
      return true;
    } catch (error: any) {
      console.error("Error sending reset email:", error);
      showToast("Lỗi gửi email: " + error.message, 'error');
      return false;
    }
  };

  const updateUserRole = async (uid: string, email: string, newRole: 'user' | 'admin') => {
    if (userRole !== 'admin' || !user) return;
    
    try {
      await setDoc(doc(db, 'users', uid), {
        role: newRole,
        updatedAt: serverTimestamp()
      }, { merge: true });
      
      showToast(`Đã cập nhật vai trò thành ${newRole === 'admin' ? 'Quản trị viên' : 'Thành viên'}`, 'success');
      await fetchAllUsers();
    } catch (error: any) {
      console.error("Error updating role:", error);
      showToast("Lỗi khi cập nhật vai trò", 'error');
    }
  };


  const changeOwnPassword = async (newPassword: string) => {
    if (!user) return;
    try {
      const { updatePassword } = await import('firebase/auth');
      await updatePassword(user, newPassword);
      return true;
    } catch (e: any) {
      console.error("Change password failed:", e);
      if (e.code === 'auth/requires-recent-login') {
        throw new Error("Hành động này yêu cầu bạn phải đăng nhập lại gần đây để xác thực.");
      }
      throw e;
    }
  };

  const handleDownload = async (pagesToDownload?: number[]) => {
    const pages = pagesToDownload || [currentPage];
    const availablePages = pages.filter(p => translations[p]?.status === 'success');
    
    if (availablePages.length === 0) return;

    try {
      const allChildren: Paragraph[] = [];
      
      for (const pageNum of availablePages) {
        const content = translations[pageNum]?.content;
        if (!content) continue;

        // Add page header
        allChildren.push(new Paragraph({
          heading: HeadingLevel.HEADING_1,
          alignment: "center",
          spacing: { before: 400, after: 200 },
          children: [
            new TextRun({
              text: `Trang ${pageNum}`,
              bold: true,
              color: "4F46E5",
              size: 32,
              font: "Times New Roman"
            })
          ]
        }));

        const lines = content.split('\n');
        const pageParagraphs = lines.map(line => {
          let text = line.trim();
          if (!text) return new Paragraph({ spacing: { after: 120 }, children: [new TextRun("")] });

          let isHeading = false;
          let headingLevel: any = undefined;

          if (text.startsWith('### ')) {
            text = text.replace('### ', '');
            isHeading = true;
            headingLevel = HeadingLevel.HEADING_3;
          } else if (text.startsWith('## ')) {
            text = text.replace('## ', '');
            isHeading = true;
            headingLevel = HeadingLevel.HEADING_2;
          } else if (text.startsWith('# ')) {
            text = text.replace('# ', '');
            isHeading = true;
            headingLevel = HeadingLevel.HEADING_1;
          }

          let isBullet = false;
          if (text.startsWith('- ') || text.startsWith('* ')) {
            text = text.substring(2);
            isBullet = true;
          }

          return new Paragraph({
            heading: isHeading ? headingLevel : undefined,
            bullet: isBullet ? { level: 0 } : undefined,
            spacing: { after: 120 },
            children: [
              new TextRun({
                text: text,
                size: isHeading ? 28 : 24,
                font: "Times New Roman",
                bold: isHeading
              })
            ]
          });
        });

        allChildren.push(...pageParagraphs);
        
        // Add page break if not the last page
        if (pageNum !== availablePages[availablePages.length - 1]) {
          allChildren.push(new Paragraph({
            children: [new TextRun({ text: "", break: 1 })]
          }));
        }
      }

      const doc = new Document({
        sections: [{
          properties: {},
          children: allChildren,
        }],
      });

      const blob = await Packer.toBlob(doc);
      const fileName = availablePages.length === 1 
        ? `MediTrans_Trang_${availablePages[0]}.docx` 
        : `MediTrans_Tong_Hop_${availablePages.length}_Trang.docx`;
      saveAs(blob, fileName);
    } catch (error) {
      console.error("Error generating docx:", error);
      // Fallback to markdown if docx fails (just for the first page if multiple)
      const firstPageContent = translations[availablePages[0]]?.content || "";
      const blob = new Blob([firstPageContent], { type: 'text/markdown' });
      saveAs(blob, `MediTrans_Trang_${availablePages[0]}.md`);
    }
  };

  const [selectedTerm, setSelectedTerm] = useState<string | null>(null);
  const [dictionaryPosition, setDictionaryPosition] = useState({ x: 0, y: 0 });
  
  const clearFile = () => {
    if (fileUrl && fileUrl.startsWith('blob:')) URL.revokeObjectURL(fileUrl);
    
    // Increment fileId to invalidate all pending translations for the previous file
    fileIdRef.current += 1;
    
    // Abort all pending translations
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    
    preTranslateControllersRef.current.forEach(controller => controller.abort());
    preTranslateControllersRef.current.clear();
    
    setFile(null);
    setCurrentFileName('');
    setFileUrl(null);
    setFileId(null);
    setPdfDoc(null);
    lastRenderedImageRef.current = null;
    setNumPages(0);
    setCurrentPage(1);
    setCurrentJob(1);
    setTranslations({});
    setPdfError(null);
    isRenderingRef.current = false;
    translatingPagesRef.current.clear();
    
    // Reset Summary State
    setTranslationPanelMode('translation');
    setSummaryText('');
    setIsSummarizing(false);
    if (summarySignalRef.current) {
      summarySignalRef.current.abort();
    }
    
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
    }

    setShowExplorer(true);
  };

  const handleDeleteCurrentFile = async () => {
    if (!fileId || isLocalOnly) {
      clearFile();
      return;
    }

    if (window.confirm(`Bạn có chắc chắn muốn XÓA vĩnh viễn tệp "${currentFileName}" khỏi hệ thống? Hành động này không thể hoàn tác.`)) {
      try {
        const userId = auth.currentUser?.uid;
        if (!userId) {
          showToast("Vui lòng đăng nhập để thực hiện thao tác này", 'error');
          return;
        }
        
        await deleteDoc(doc(db, `users/${userId}/documents`, fileId));
        showToast("Đã xóa tài liệu thành công", 'success');
        clearFile();
      } catch (error: any) {
        console.error("Lỗi khi xóa tài liệu:", error);
        if (error.message?.includes('permission-denied') || error.message?.includes('PERMISSION_DENIED')) {
          showToast("Bạn không có quyền xóa tài liệu này.", 'error');
        } else {
          showToast("Không thể xóa tài liệu. Vui lòng thử lại sau.", 'error');
        }
      }
    }
  };

  const handleSummarize = async (type: 'page' | 'document' | 'chapter') => {
    if (!translationService.current) return;
    
    let contentToSummarize = "";
    
    if (type === 'page') {
      contentToSummarize = translations[currentPage]?.content || "";
      if (!contentToSummarize) {
        showToast("Vui lòng dịch trang này trước khi tóm tắt.", 'info');
        return;
      }
    } else if (type === 'chapter') {
      const startPage = Math.max(1, summaryRange.from);
      const endPage = Math.min(numPages, summaryRange.to);
      
      if (startPage > endPage) {
        showToast("Khoảng trang không hợp lệ.", 'error');
        return;
      }

      const pages = Object.keys(translations)
        .map(Number)
        .filter(p => p >= startPage && p <= endPage)
        .sort((a, b) => a - b);
        
      if (pages.length === 0) {
        showToast(`Không tìm thấy trang nào được dịch trong khoảng từ ${startPage} đến ${endPage}.`, 'info');
        return;
      }
      
      contentToSummarize = pages
        .map(p => `--- Trang ${p} ---\n${translations[p].content}`)
        .join("\n\n");

      if (pages.length < (endPage - startPage + 1)) {
        showToast(`Đang tóm tắt dựa trên ${pages.length} trang đã dịch trong khoảng từ ${startPage} đến ${endPage}.`, 'info');
      }
    } else if (type === 'document') {
      // Collect all translated pages
      const pages = Object.keys(translations).map(Number).sort((a, b) => a - b);
      if (pages.length === 0) {
        showToast("Chưa có nội dung nào được dịch để tóm tắt.", 'info');
        return;
      }
      
      contentToSummarize = pages
        .map(p => `--- Trang ${p} ---\n${translations[p].content}`)
        .join("\n\n");
        
      if (type === 'document' && pages.length < numPages) {
        if (!window.confirm(`Bạn mới chỉ dịch ${pages.length}/${numPages} trang. Bạn có muốn tóm tắt dựa trên những trang đã dịch không?`)) {
          return;
        }
      }
    }

    setTranslationPanelMode('summary');
    setSummaryText('');
    setIsSummarizing(true);
    
    if (summarySignalRef.current) {
      summarySignalRef.current.abort();
    }
    summarySignalRef.current = new AbortController();
    
    try {
      const g = (translationService.current as any).summarizeContent(
        contentToSummarize, 
        type, 
        summarySignalRef.current.signal
      );
      
      let fullSummary = "";
      for await (const chunk of g) {
        fullSummary += chunk;
        setSummaryText(fullSummary);
      }
    } catch (error: any) {
      if (error.message !== "Summarization aborted") {
        console.error("Summarization error:", error);
        showToast(`Lỗi tóm tắt: ${error.message}`, 'error');
      }
    } finally {
      setIsSummarizing(false);
      summarySignalRef.current = null;
    }
  };

  const handleSaveSummary = async () => {
    if (!summaryText || isSummarizing) return;
    if (!fileId || isLocalOnly) {
      showToast("Vui lòng tải tệp lên đám mây để lưu tóm tắt.", 'info');
      return;
    }

    const userId = auth.currentUser?.uid;
    if (!userId) {
      showToast("Vui lòng đăng nhập để lưu tóm tắt.", 'error');
      return;
    }

    setIsSavingSummary(true);
    try {
      const summaryId = `summary_${Date.now()}`;
      await setDoc(doc(db, `users/${userId}/documents/${fileId}/summaries`, summaryId), {
        content: summaryText,
        type: summaryRange.from === summaryRange.to ? 'page' : 'chapter', // approximation
        range: `${summaryRange.from}-${summaryRange.to}`,
        createdAt: serverTimestamp()
      });
      showToast("Đã lưu tóm tắt thành công", 'success');
    } catch (error: any) {
      console.error("Lỗi khi lưu tóm tắt:", error);
      handleFirestoreError(error, OperationType.CREATE, `users/${userId}/documents/${fileId}/summaries`);
    } finally {
      setIsSavingSummary(false);
    }
  };

  const handleDownloadSummary = async () => {
    if (!summaryText) return;
    
    try {
      showToast("Đang chuẩn bị tệp Word...", 'info');
      
      const fileNameWithoutExt = (currentFileName || 'document').replace(/\.[^/.]+$/, "");
      
      const doc = new Document({
        sections: [{
          properties: {},
          children: [
            new Paragraph({
              text: `TÓM TẮT TÀI LIỆU`,
              heading: HeadingLevel.HEADING_1,
              spacing: { after: 400 }
            }),
            new Paragraph({
              children: [
                new TextRun({
                  text: `Tên tài liệu: ${currentFileName || 'Không rõ'}`,
                  bold: true
                })
              ],
              spacing: { after: 200 }
            }),
            new Paragraph({
              text: `Ngày tạo: ${new Date().toLocaleString('vi-VN')}`,
              spacing: { after: 400 }
            }),
            ...summaryText.split('\n').map(line => {
              const trimmed = line.trim();
              if (!trimmed) return new Paragraph({ text: "" });

              const isHeading = trimmed.startsWith('#');
              const level = trimmed.match(/^#+/)?.[0].length || 0;
              const cleanText = trimmed.replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/\*/g, '');

              return new Paragraph({
                heading: isHeading ? (level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2) : undefined,
                spacing: { before: isHeading ? 200 : 100, after: 100 },
                children: [
                   new TextRun({
                     text: cleanText,
                     bold: trimmed.includes('**') || isHeading
                   })
                ]
              });
            })
          ],
        }],
      });

      const blob = await Packer.toBlob(doc);
      saveAs(blob, `TomTat_${fileNameWithoutExt}.docx`);
      showToast("Đã bắt đầu tải xuống tóm tắt (.docx)", 'success');
    } catch (error) {
      console.error("Lỗi khi tải xuống tóm tắt Word:", error);
      showToast("Không thể tải xuống tóm tắt dạng Word", 'error');
    }
  };

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renderTaskRef = useRef<any>(null);
  const lastRenderedImageRef = useRef<{ page: number, zoom: number, buffer: string } | null>(null);
  const translationService = useRef<TranslationService | null>(null);

  // Pre-load PDF worker
  useEffect(() => {
    console.log(`[MediTrans AI] Pre-loading PDF worker v${pdfjs.version}...`);
  }, []);

  const handleFileSelectFromExplorer = async (fileData: FileData) => {
    setIsPdfLoading(true);
    setPdfError(null);
    setFileId(fileData.id);
    setCurrentFileName(fileData.name);
    setShowExplorer(false);
    setIsLocalOnly(false);

    // On mobile, switch to split view automatically when opening a file
    if (window.innerWidth < 768) {
      setMobileViewMode('split');
    }

    // Increment fileId to invalidate all pending translations for the previous file
    fileIdRef.current += 1;
    
    // Abort all pending translations
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    
    preTranslateControllersRef.current.forEach(controller => controller.abort());
    preTranslateControllersRef.current.clear();
    translatingPagesRef.current.clear();
    pageCacheRef.current.clear();

    setFile(null); // We don't have a local File object
    setTranslations({});
    setCurrentPage(1);
    setCurrentJob(1);
    setAutoTranslate(false);

    try {
      // Use the TinyVault download URL
      const url = fileData.downloadUrl;
      setFileUrl(url);
      
      console.log(`[MediTrans AI] Loading PDF from TinyVault: ${fileData.name}`);

      const loadingTask = pdfjs.getDocument({
        url,
        cMapUrl: `https://unpkg.com/pdfjs-dist@3.11.174/cmaps/`,
        cMapPacked: true,
        disableAutoFetch: false,
        disableStream: false,
      });

      const pdf = await loadingTask.promise;
      setPdfDoc(pdf);
      setNumPages(pdf.numPages);
    } catch (error: any) {
      console.error("Error loading PDF from TinyVault:", error);
      setPdfError(`Không thể tải file PDF từ TinyVault: ${error.message || "Lỗi không xác định"}`);
    } finally {
      setIsPdfLoading(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    // Reset input value so the same file can be selected again
    e.target.value = '';
    
    if (!selectedFile) return;

    // Check file size (200MB limit)
    if (selectedFile.size > 200 * 1024 * 1024) {
      setUploadError("File quá lớn. Vui lòng chọn file dưới 200MB.");
      setTimeout(() => setUploadError(null), 5000);
      return;
    }

    const isPdf = selectedFile.type === 'application/pdf' || 
                  selectedFile.type === 'application/x-pdf' ||
                  selectedFile.name.toLowerCase().endsWith('.pdf');
    
    if (isPdf) {
      setIsPdfLoading(true);
      setPdfError(null);
      
      // Generate a document ID based on filename and size
      const docId = `${selectedFile.name.replace(/[^a-zA-Z0-9]/g, '_')}_${selectedFile.size}`;
      setFileId(docId);
      setCurrentFileName(selectedFile.name);

      // On mobile, switch to split view automatically when opening a file
      if (window.innerWidth < 768) {
        setMobileViewMode('split');
      }

      // Small delay to allow UI to update and browser to settle after file picker
      await new Promise(resolve => setTimeout(resolve, 100));

      // Clear previous
      if (fileUrl) URL.revokeObjectURL(fileUrl);
      if (pdfDoc) {
        try {
          await pdfDoc.destroy();
        } catch (e) {
          console.warn("Error destroying previous PDF:", e);
        }
      }

      // Increment fileId to invalidate all pending translations for the previous file
      fileIdRef.current += 1;
      
      // Abort all pending translations
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      
      preTranslateControllersRef.current.forEach(controller => controller.abort());
      preTranslateControllersRef.current.clear();
      translatingPagesRef.current.clear();
      pageCacheRef.current.clear();

      setFile(selectedFile);
      setTranslations({});
      setCurrentPage(1);
      setCurrentJob(1);
      setAutoTranslate(false);
      
      try {
        // For iOS Chrome/Safari stability, we'll try loading via ArrayBuffer if Blob URL fails
        // but first try the efficient Blob URL method
        const url = URL.createObjectURL(selectedFile);
        setFileUrl(url);
        
        console.log(`[MediTrans AI] Loading PDF: ${selectedFile.name} (${Math.round(selectedFile.size / 1024)} KB)`);

        const loadingTask = pdfjs.getDocument({
          url,
          // Use unpkg for cmaps as well for consistency with worker
          cMapUrl: `https://unpkg.com/pdfjs-dist@3.11.174/cmaps/`,
          cMapPacked: true,
          disableAutoFetch: false,
          disableStream: false,
        });

        const pdf = await loadingTask.promise;
        setPdfDoc(pdf);
        setNumPages(pdf.numPages);
      } catch (error: any) {
        console.error("Error loading PDF with Blob URL, trying ArrayBuffer fallback:", error);
        
        try {
          // Fallback: Read as ArrayBuffer (more stable on some mobile browsers)
          const arrayBuffer = await selectedFile.arrayBuffer();
          const loadingTask = pdfjs.getDocument({
            data: arrayBuffer,
            cMapUrl: `https://unpkg.com/pdfjs-dist@3.11.174/cmaps/`,
            cMapPacked: true,
          });
          const pdf = await loadingTask.promise;
          setPdfDoc(pdf);
          setNumPages(pdf.numPages);
        } catch (fallbackError: any) {
          console.error("Final PDF loading error:", fallbackError);
          setPdfError(`Không thể tải file PDF: ${fallbackError.message || "Lỗi không xác định"}`);
        }
      } finally {
        setIsPdfLoading(false);
      }
    } else {
      setUploadError("Vui lòng chọn file định dạng PDF.");
      setTimeout(() => setUploadError(null), 5000);
    }
  };

  const renderPage = useCallback(async (pageNum: number) => {
    if (!pdfDoc || !canvasRef.current || !textLayerRef.current) return;

    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    // Bounds check to prevent "Invalid page request"
    if (pageNum < 1 || pageNum > pdfDoc.numPages) {
      console.warn(`[MediTrans AI] Invalid page request: ${pageNum}. Document has ${pdfDoc.numPages} pages.`);
      return;
    }

    const requestId = ++renderRequestIdRef.current;

    // 1. Instant Cache Check - If we have this page rendered at this zoom, show it immediately!
    const cached = pageCacheRef.current.get(pageNum);
    if (cached && Math.abs(cached.zoom - zoom) < 0.01) {
      console.log(`[MediTrans] Instant Cache Hit for page ${pageNum}`);
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d', { alpha: false });
      if (context) {
        canvas.width = cached.canvas.width;
        canvas.height = cached.canvas.height;
        canvas.style.width = cached.canvas.style.width;
        canvas.style.height = cached.canvas.style.height;
        context.drawImage(cached.canvas, 0, 0);
        
        // Restore text layer if available
        if (cached.textContent && textLayerRef.current) {
          const textLayerDiv = textLayerRef.current;
          textLayerDiv.innerHTML = '';
          const page = await pdfDoc.getPage(pageNum);
          const textViewport = page.getViewport({ scale: zoom });
          textLayerDiv.style.width = `${textViewport.width}px`;
          textLayerDiv.style.height = `${textViewport.height}px`;
          textLayerDiv.style.setProperty('--scale-factor', textViewport.scale.toString());
          
          await (pdfjs as any).renderTextLayer({
            textContentSource: cached.textContent,
            container: textLayerDiv,
            viewport: textViewport,
            textDivs: []
          }).promise;
          page.cleanup();
        }
        
        setIsRendering(false);
        isRenderingRef.current = false;
        return;
      }
    }

    setIsRendering(true);
    isRenderingRef.current = true;

    // Ensure previous render task is cancelled
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }

    // Give a tiny gap for the main thread to breathe during rapid navigation
    if (isMobile) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // Check if a newer request has come in while we were waiting
    if (requestId !== renderRequestIdRef.current) {
      return;
    }

    try {
      const page = await pdfDoc.getPage(pageNum);
      
      // iOS Canvas Limit Check: Ensure canvas doesn't exceed 4096px which is safe for most mobile browsers
      const MAX_CANVAS_DIMENSION = 4096;
      let renderScale = zoom * 2;
      const baseViewport = page.getViewport({ scale: 1 });
      
      if (baseViewport.width * renderScale > MAX_CANVAS_DIMENSION || baseViewport.height * renderScale > MAX_CANVAS_DIMENSION) {
        renderScale = Math.min(MAX_CANVAS_DIMENSION / baseViewport.width, MAX_CANVAS_DIMENSION / baseViewport.height);
        console.log(`[MediTrans] Đã giới hạn tỉ lệ render cho mobile: ${renderScale}`);
      }
      
      const viewport = page.getViewport({ scale: renderScale });
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d', { alpha: false }); // Optimization: disable alpha if not needed

      if (context) {
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        canvas.style.width = `${viewport.width / (renderScale / zoom)}px`;
        canvas.style.height = `${viewport.height / (renderScale / zoom)}px`;
        
        const renderTask = page.render({
          canvasContext: context,
          viewport: viewport,
        } as any);
        renderTaskRef.current = renderTask;
        await renderTask.promise;
        
        // Small delay for mobile browsers to ensure canvas buffer is flushed before capture
        if (isMobile) {
          await new Promise(resolve => setTimeout(resolve, 150));
        }

        // Only update state if this is still the current request
        if (requestId === renderRequestIdRef.current) {
          // Signal that visual rendering is done so translation can start immediately
          setIsRendering(false);
          isRenderingRef.current = false;
          renderTaskRef.current = null;
          
          // LAZY OPERATIONS: Capture image and Text layer slightly after visual render
          // This prevents the UI from "freezing" between page turns
          setTimeout(async () => {
             if (requestId !== renderRequestIdRef.current) return;

             try {
               // 1. Capture for Translation
               const MAX_DIMENSION = 1024;
               let captureCanvas = canvas;
               
               if (canvas.width > MAX_DIMENSION || canvas.height > MAX_DIMENSION) {
                 const tempCanvas = document.createElement('canvas');
                 const ratio = Math.min(MAX_DIMENSION / canvas.width, MAX_DIMENSION / canvas.height);
                 tempCanvas.width = canvas.width * ratio;
                 tempCanvas.height = canvas.height * ratio;
                 const tempCtx = tempCanvas.getContext('2d');
                 if (tempCtx) {
                   tempCtx.drawImage(canvas, 0, 0, tempCanvas.width, tempCanvas.height);
                   captureCanvas = tempCanvas;
                 }
               }
               
               const buffer = captureCanvas.toDataURL('image/jpeg', 0.65);
               if (buffer.length > 1000) {
                 lastRenderedImageRef.current = { page: pageNum, zoom, buffer };
               }

               // 2. Render Text Layer
               const textContent = await page.getTextContent();
               
               // Cache this result for next time
               if (requestId === renderRequestIdRef.current) {
                 const cacheCanvas = document.createElement('canvas');
                 cacheCanvas.width = canvas.width;
                 cacheCanvas.height = canvas.height;
                 cacheCanvas.style.width = canvas.style.width;
                 cacheCanvas.style.height = canvas.style.height;
                 const cacheCtx = cacheCanvas.getContext('2d');
                 if (cacheCtx) cacheCtx.drawImage(canvas, 0, 0);
                 
                 pageCacheRef.current.set(pageNum, { 
                   canvas: cacheCanvas, 
                   zoom, 
                   textContent 
                 });

                 // LRU: Evict oldest if limit reached
                 if (pageCacheRef.current.size > CACHE_SIZE_LIMIT) {
                   const oldestKey = pageCacheRef.current.keys().next().value;
                   if (oldestKey !== undefined) {
                     const old = pageCacheRef.current.get(oldestKey);
                     if (old?.canvas) {
                       old.canvas.width = 0;
                       old.canvas.height = 0;
                     }
                     pageCacheRef.current.delete(oldestKey);
                   }
                 }
               }

               const textLayerDiv = textLayerRef.current;
               if (textLayerDiv && requestId === renderRequestIdRef.current) {
                 textLayerDiv.innerHTML = '';
                 const textViewport = page.getViewport({ scale: zoom });
                 textLayerDiv.style.width = `${textViewport.width}px`;
                 textLayerDiv.style.height = `${textViewport.height}px`;
                 textLayerDiv.style.left = '0';
                 textLayerDiv.style.top = '0';
                 textLayerDiv.style.setProperty('--scale-factor', textViewport.scale.toString());
                 
                 await (pdfjs as any).renderTextLayer({
                   textContentSource: textContent,
                   container: textLayerDiv,
                   viewport: textViewport,
                   textDivs: []
                 }).promise;
               }
             } catch (err) {
               console.warn("[MediTrans] Lazy post-render failed:", err);
             } finally {
               // Crucial for memory: cleanup page resources
               page.cleanup();
             }
          }, 150);
        }
      }
    } catch (error: any) {
      if (error.name !== 'RenderingCancelledException') {
        console.error("Error rendering page:", error);
      }
      
      if (requestId === renderRequestIdRef.current) {
        setIsRendering(false);
        isRenderingRef.current = false;
        renderTaskRef.current = null;
      }
    }
  }, [pdfDoc, zoom]);

  const fitToWidth = async () => {
    if (!pdfDoc || !containerRef.current) return;
    
    // Use the current page from the doc to be safe
    const pageToFit = currentPage;
    if (pageToFit < 1 || pageToFit > pdfDoc.numPages) return;

    requestAnimationFrame(async () => {
      if (!pdfDoc || !containerRef.current) return;
      try {
        const page = await pdfDoc.getPage(pageToFit);
        const viewport = page.getViewport({ scale: 1 });
        const rect = containerRef.current.getBoundingClientRect();
        const containerWidth = rect.width - 64;
        const newZoom = containerWidth / viewport.width;
        setZoom(Number(newZoom.toFixed(2)));
        page.cleanup();
      } catch (error) {
        console.error("Error fitting to width:", error);
      }
    });
  };

  useEffect(() => {
    if (pdfDoc && isAutoFit) {
      fitToWidth();
    }
  }, [mobileViewMode, pdfDoc, isAutoFit]);

  const fitToWidthAction = () => {
    setIsAutoFit(true);
    fitToWidth();
  };

  const cancelTranslation = useCallback(() => {
    const currentFileId = fileIdRef.current;
    
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsTranslating(false);
    setActiveTranslation(null);
    
    // Update status of the page being translated to error or idle
    const targetPage = currentPage;
    if (translatingPagesRef.current.has(targetPage)) {
      if (fileIdRef.current === currentFileId) {
        setTranslations(prev => ({
          ...prev,
          [targetPage]: { ...prev[targetPage], status: 'error', content: 'Đã dừng dịch thuật.' }
        }));
      }
      translatingPagesRef.current.delete(targetPage);
    }
  }, [currentPage]);

  const translateCurrentPage = useCallback(async (pageNumber?: number, force = false) => {
    const targetPage = pageNumber ?? currentPage;
    const currentFileId = fileIdRef.current;
    
    if (!canvasRef.current || !translationService.current || !currentFileId) return;

    // 1. Double initiation check
    const currentStatus = translationsRef.current[targetPage]?.status;
    if (!force && (currentStatus === 'loading' || currentStatus === 'success')) {
      if (translatingPagesRef.current.has(targetPage)) return;
    }

    // 2. Promotion check
    if (translatingPagesRef.current.has(targetPage) && !force) {
      console.log(`[MediTrans] Promoting pre-translation for page ${targetPage}`);
      setIsTranslating(true);
      setActiveTranslation(prev => (prev?.page === targetPage) ? prev : { page: targetPage, content: '', status: 'loading' });
      return;
    }

    // 3. Mark as translating
    translatingPagesRef.current.add(targetPage);
    setIsTranslating(true);
    setActiveTranslation({ page: targetPage, content: '', status: 'loading' });

    // 4. Abort previous foreground task
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const { signal } = controller;

    // 5. Render safety check
    if (isRenderingRef.current) {
      console.log(`[MediTrans] Đang render trang ${targetPage}, chờ một lát...`);
      setTimeout(() => {
        if (currentPageRef.current === targetPage) {
          translatingPagesRef.current.delete(targetPage);
          translateCurrentPage(targetPage, force);
        }
      }, 100);
      return;
    }
    
    // 6. API Key check
    const hasKey = await translationService.current.hasApiKey();
    if (!hasKey) {
      setTranslations(prev => ({
        ...prev,
        [targetPage]: { content: 'Vui lòng cài đặt API Key.', status: 'error' }
      }));
      setActiveTranslation(null);
      setIsTranslating(false);
      translatingPagesRef.current.delete(targetPage);
      return;
    }

    // 7. Capture & Translate
    try {
      const startTime = Date.now();
      const originalCanvas = canvasRef.current;
      const MAX_DIMENSION = 1024; 
      
      // OPTIMIZATION for Page 1: Split into two parallel requests for speed
      if (targetPage === 1 && !force) {
        console.log("[MediTrans] Using Split Strategy for Page 1 speedup...");
        
        let resizedWidth = originalCanvas.width;
        let resizedHeight = originalCanvas.height;
        if (resizedWidth > MAX_DIMENSION || resizedHeight > MAX_DIMENSION) {
          const ratio = Math.min(MAX_DIMENSION / resizedWidth, MAX_DIMENSION / resizedHeight);
          resizedWidth *= ratio;
          resizedHeight *= ratio;
        }

        const createPartBuffer = (yOffset: number, height: number) => {
          const partCanvas = document.createElement('canvas');
          partCanvas.width = resizedWidth;
          partCanvas.height = height;
          const ctx = partCanvas.getContext('2d');
          if (ctx) {
            const sourceY = (yOffset / resizedHeight) * originalCanvas.height;
            const sourceH = (height / resizedHeight) * originalCanvas.height;
            ctx.drawImage(originalCanvas, 0, sourceY, originalCanvas.width, sourceH, 0, 0, resizedWidth, height);
          }
          return partCanvas.toDataURL('image/jpeg', 0.65);
        };

        const topBuffer = createPartBuffer(0, resizedHeight * 0.6);
        const bottomBuffer = createPartBuffer(resizedHeight * 0.4, resizedHeight * 0.6);

        let topContent = "";
        let bottomContent = "";
        
        const topStream = translationService.current.translateMedicalPageStream({ 
          imageBuffer: topBuffer, pageNumber: targetPage, signal, part: 'top' 
        });
        const bottomStream = translationService.current.translateMedicalPageStream({ 
          imageBuffer: bottomBuffer, pageNumber: targetPage, signal, part: 'bottom' 
        });

        const updateUI = () => {
          const combined = topContent + (bottomContent ? "\n\n---\n\n" + bottomContent : "");
          setActiveTranslation({ page: targetPage, content: combined, status: 'loading' });
        };

        await Promise.all([
          (async () => {
            for await (const chunk of topStream) {
              topContent += chunk;
              updateUI();
            }
          })(),
          (async () => {
            for await (const chunk of bottomStream) {
              bottomContent += chunk;
              updateUI();
            }
          })()
        ]);

        const fullContent = topContent + "\n\n---\n\n" + bottomContent;
        const finalResult = { content: fullContent, status: 'success' as const };
        
        if (fileIdRef.current === currentFileId) {
          setTranslations(prev => ({ ...prev, [targetPage]: finalResult }));
          setActiveTranslation({ page: targetPage, content: fullContent, status: 'success' });
          if (user && fileId) {
            setDoc(doc(db, 'users', user.uid, 'documents', fileId, 'pages', targetPage.toString()), {
              content: fullContent, status: 'success', updatedAt: serverTimestamp()
            }).catch(e => console.error("Firestore save error:", e));
          }
        }
      } else {
        // Standard Strategy for other pages
        let captureCanvas = originalCanvas;
        if (originalCanvas.width > MAX_DIMENSION || originalCanvas.height > MAX_DIMENSION) {
          const tempCanvas = document.createElement('canvas');
          const ratio = Math.min(MAX_DIMENSION / originalCanvas.width, MAX_DIMENSION / originalCanvas.height);
          tempCanvas.width = originalCanvas.width * ratio;
          tempCanvas.height = originalCanvas.height * ratio;
          const tempCtx = tempCanvas.getContext('2d');
          if (tempCtx) {
            tempCtx.drawImage(originalCanvas, 0, 0, tempCanvas.width, tempCanvas.height);
            captureCanvas = tempCanvas;
          }
        }

        const imageBuffer = captureCanvas.toDataURL('image/jpeg', 0.65);
        if (!imageBuffer || imageBuffer.length < 1000) {
          throw new Error("Không thể chụp ảnh trang.");
        }

        const stream = translationService.current.translateMedicalPageStream({ imageBuffer, pageNumber: targetPage, signal });
        let fullContent = "";
        let lastUpdateTime = Date.now();

        for await (const chunk of stream) {
          fullContent += chunk;
          const now = Date.now();
          if (now - lastUpdateTime > 100) {
            setActiveTranslation({ page: targetPage, content: fullContent, status: 'loading' });
            lastUpdateTime = now;
          }
        }
        
        const finalResult = { content: fullContent, status: 'success' as const };
        
        if (fileIdRef.current === currentFileId) {
          setTranslations(prev => ({ ...prev, [targetPage]: finalResult }));
          setActiveTranslation({ page: targetPage, content: fullContent, status: 'success' });
          
          if (user && fileId) {
            setDoc(doc(db, 'users', user.uid, 'documents', fileId, 'pages', targetPage.toString()), {
              content: fullContent, status: 'success', updatedAt: serverTimestamp()
            }).catch(e => console.error("Firestore save error:", e));
          }
        }
      }
      
      console.log(`[MediTrans] Finished page ${targetPage} in ${Date.now() - startTime}ms`);
      
      // Delay clearing active translation to avoid visual jump
      setTimeout(() => {
        if (currentPageRef.current === targetPage) {
          setActiveTranslation(null);
        }
      }, 300);

    } catch (error: any) {
      if (error.message === "Translation aborted" || error.name === 'AbortError') return;
      console.error("Translation Error:", error);
      if (fileIdRef.current === currentFileId) {
        setTranslations(prev => ({ ...prev, [targetPage]: { content: error.message || 'Lỗi dịch thuật', status: 'error' } }));
      }
      setActiveTranslation(null);
    } finally {
      translatingPagesRef.current.delete(targetPage);
      if (abortControllerRef.current?.signal === signal) {
        setIsTranslating(false);
        abortControllerRef.current = null;
      }
    }
  }, [currentPage, translationService, user, fileId]);

  const preTranslatePage = useCallback(async (pageNum: number, signal?: AbortSignal) => {
    if (!pdfDoc || !translationService.current || pageNum > numPages) return;
    const currentFileId = fileIdRef.current;

    if (signal?.aborted) return;

    // Avoid double translation
    const currentStatus = translationsRef.current[pageNum]?.status;
    if (translatingPagesRef.current.has(pageNum) || currentStatus === 'loading' || currentStatus === 'success') {
      return;
    }

    translatingPagesRef.current.add(pageNum);
    
    try {
      const page = await pdfDoc.getPage(pageNum);
      if (signal?.aborted) {
        page.cleanup();
        translatingPagesRef.current.delete(pageNum);
        return;
      }

      // 1. Render in background to image
      const viewport = page.getViewport({ scale: 2 }); 
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const context = canvas.getContext('2d');
      
      if (context) {
        const renderTask = page.render({ canvasContext: context, viewport: viewport } as any);
        const abortHandler = () => renderTask.cancel();
        if (signal) signal.addEventListener('abort', abortHandler);
        try {
          await renderTask.promise;
        } finally {
          if (signal) signal.removeEventListener('abort', abortHandler);
        }
        
        if (signal?.aborted) {
          page.cleanup();
          translatingPagesRef.current.delete(pageNum);
          return;
        }

        const imageBuffer = canvas.toDataURL('image/jpeg', 0.8);
        canvas.width = 0; canvas.height = 0; // memory cleanup

        // 2. Start translation stream
        const stream = translationService.current.translateMedicalPageStream({
          imageBuffer, pageNumber: pageNum, signal
        });
        
        let fullContent = "";
        let lastUpdateTime = Date.now();

        for await (const chunk of stream) {
          if (signal?.aborted) break;
          fullContent += chunk;
          
          const now = Date.now();
          // If the user has moved to this page while it was being pre-translated, show progress
          // We check more frequently if it becomes the currently viewed page
          const isCurrent = pageNum === currentPageRef.current;
          if (isCurrent && (now - lastUpdateTime > 100)) {
            setActiveTranslation({ page: pageNum, content: fullContent, status: 'loading' });
            setIsTranslating(true);
            lastUpdateTime = now;
          }
        }
        
        if (signal?.aborted) return;

        const finalResult = { content: fullContent, status: 'success' as const };
        
        if (fileIdRef.current === currentFileId) {
          setTranslations(prev => {
             const updated = { ...prev, [pageNum]: finalResult };
             translationsRef.current = updated;
             return updated;
          });
          
          // Show final results immediately if we are on this page
          if (pageNum === currentPageRef.current) {
            setActiveTranslation({ page: pageNum, content: fullContent, status: 'success' });
            setIsTranslating(true);
            setTimeout(() => {
              if (currentPageRef.current === pageNum) setActiveTranslation(null);
            }, 300);
          }
          
          if (user && fileId) {
            setDoc(doc(db, 'users', user.uid, 'documents', fileId, 'pages', pageNum.toString()), {
              content: fullContent, status: 'success', updatedAt: serverTimestamp()
            }, { merge: true }).catch(e => console.error("Firestore pre-save error:", e));
          }
        }
      }
      page.cleanup();
    } catch (error: any) {
      if (error.message === "Translation aborted" || error.name === 'AbortError') return;
      console.error(`Pre-translation error for page ${pageNum}:`, error);
    } finally {
      translatingPagesRef.current.delete(pageNum);
      if (pageNum === currentPageRef.current) setIsTranslating(false);
    }
  }, [pdfDoc, numPages, user, fileId, translationService]);

  useEffect(() => {
    if (pdfDoc && autoTranslate) {
      // Find all pages in the look-ahead window that need translation
      const pagesToBuffer = [];
      for (let i = 1; i <= autoTranslateLookAhead; i++) {
        const pageNum = currentPage + i;
        if (pageNum <= numPages && 
            !translationsRef.current[pageNum] && 
            !translatingPagesRef.current.has(pageNum)) {
          pagesToBuffer.push(pageNum);
        }
      }

      if (pagesToBuffer.length === 0) return;

      // Limit concurrent translations to avoid browser/network congestion, 
      // even if we have many keys. 5 is a good balance.
      const MAX_CONCURRENT_PRE_TRANSLATION = 5;
      const currentConcurrency = translatingPagesRef.current.size;
      const spaceLeft = MAX_CONCURRENT_PRE_TRANSLATION - currentConcurrency;

      if (spaceLeft <= 0) return;

      const pagesToStart = pagesToBuffer.slice(0, spaceLeft);

      pagesToStart.forEach((pageNum, index) => {
        const controller = new AbortController();
        preTranslateControllersRef.current.set(pageNum, controller);
        
        // Stagger starts slightly (200ms) to avoid simultaneous browser capture CPU peaks
        setTimeout(() => {
          preTranslatePage(pageNum, controller.signal).finally(() => {
            preTranslateControllersRef.current.delete(pageNum);
          });
        }, index * 200);
      });
    }
  }, [currentPage, pdfDoc, autoTranslate, numPages, preTranslatePage, autoTranslateLookAhead]);

  useEffect(() => {
    if (user && fileId) {
      console.log(`[MediTrans] Listening for translations for document: ${fileId}`);
      const q = query(collection(db, 'users', user.uid, 'documents', fileId, 'pages'));
      const unsubscribe = onSnapshot(q, (snapshot) => {
        const remoteTranslations: TranslationState = {};
        snapshot.docs.forEach(doc => {
          const data = doc.data();
          remoteTranslations[parseInt(doc.id)] = {
            content: data.content,
            status: data.status as any
          };
        });
        
        setTranslations(prev => {
          const newState = { ...prev };
          Object.keys(remoteTranslations).forEach(page => {
            const pageNum = parseInt(page);
            // Only update if we don't have it locally or if it's currently loading/error
            // AND the page is not currently being translated locally
            if (!newState[pageNum] || (newState[pageNum].status !== 'success' && !translatingPagesRef.current.has(pageNum))) {
              newState[pageNum] = remoteTranslations[pageNum];
            }
          });
          return newState;
        });
      }, (error) => {
        const path = `users/${user.uid}/documents/${fileId}/pages`;
        handleFirestoreError(error, OperationType.GET, path);
      });
      return () => unsubscribe();
    }
  }, [user, fileId]);

  const currentEngineRef = useRef<string | null>(null);
  const currentKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const currentEngineType = selectedEngine.startsWith('gemini') ? 'gemini' : selectedEngine;
    
    // Collect all available keys for this engine to support rotation
    let allKeys: string[] = [];
    
    // 1. Primary key (selected from vault or default from engineKeys)
    let primaryKey = engineKeys[selectedEngine];
    if (user && selectedKeyId) {
      const vaultKey = userKeys.find(k => k.id === selectedKeyId);
      if (vaultKey && vaultKey.engine === currentEngineType) {
        primaryKey = vaultKey.value;
      }
    }
    if (primaryKey) allKeys.push(primaryKey);

    // 2. Other keys from vault for the same engine
    if (user && userKeys.length > 0) {
      const otherVaultKeys = userKeys
        .filter(k => k.engine === currentEngineType && k.id !== selectedKeyId && k.status !== 'error')
        .map(k => k.value);
      allKeys = [...allKeys, ...otherVaultKeys];
    }

    // 3. Default key from engineKeys if not already added
    const defaultKey = engineKeys[selectedEngine];
    if (defaultKey && !allKeys.includes(defaultKey)) {
      allKeys.push(defaultKey);
    }

    // Deduplicate
    allKeys = Array.from(new Set(allKeys));
    const keyString = allKeys.join(',');

    if (currentEngineRef.current === selectedEngine && currentKeyRef.current === keyString) {
      return;
    }

    currentEngineRef.current = selectedEngine;
    currentKeyRef.current = keyString;

    if (selectedEngine === 'gemini-flash') {
      translationService.current = new GeminiService(allKeys, "gemini-flash-latest");
    } else if (selectedEngine === 'gemini-pro') {
      translationService.current = new GeminiService(allKeys, "gemini-3-flash-preview");
    } else if (selectedEngine === 'medical-specialized') {
      translationService.current = new MedicalApiService(primaryKey);
    }

    // Log key initialization for debugging
    if (allKeys.length > 0) {
      console.log(`[MediTrans AI] Initialized ${selectedEngine} with ${allKeys.length} keys.`);
    } else {
      console.log(`[MediTrans AI] Initialized ${selectedEngine} with system default key`);
    }
  }, [selectedEngine, engineKeys, user, selectedKeyId, userKeys]);

  // Handle Focus Mode (FullScreen) transitions
  useEffect(() => {
    if (file) {
      // Set auto-fit to true when toggling focus mode to ensure it fills the space
      setIsAutoFit(true);
      
      // Small delay to allow layout transitions to complete before measuring
      const timer = setTimeout(() => {
        fitToWidth();
      }, 350);
      return () => clearTimeout(timer);
    }
  }, [isFullScreen, file]);

  // Handle PDF document load
  useEffect(() => {
    if (pdfDoc) {
      fitToWidth();
    }
  }, [pdfDoc]);

  // Handle container resize to maintain fit-to-width if enabled
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pdfDoc || !isAutoFit) return;

    const observer = new ResizeObserver(() => {
      fitToWidth();
    });
    
    observer.observe(container);
    return () => observer.disconnect();
  }, [pdfDoc, isAutoFit, currentPage]);

  useEffect(() => {
    if (!pdfDoc || !autoTranslate) return;

    // Debounce auto-translation to prevent hammering the API when scrolling fast
    const timer = setTimeout(() => {
      const translation = translationsRef.current[currentPage];
      const isDone = translation?.status === 'success';
      const isForegroundActive = isTranslatingRef.current && activeTranslation?.page === currentPage;
      
      // We trigger if the page is not done and not already translating in foreground.
      // translateCurrentPage internally handles if it's already in background (translatingPagesRef).
      if (!isRenderingRef.current && !isDone && !isForegroundActive) {
        translateCurrentPage(currentPage);
      }
    }, 600); // Slightly more responsive debounce

    return () => clearTimeout(timer);
  }, [currentPage, pdfDoc, autoTranslate, isRendering, isTranslating, translateCurrentPage, activeTranslation?.page]);

  useEffect(() => {
    if (pdfDoc) {
      renderPage(currentPage);
      
      // Predictive Background Rendering - Render next page in advance
      const nextP = currentPage + 1;
      if (nextP <= numPages && !pageCacheRef.current.has(nextP)) {
        const timer = setTimeout(async () => {
          try {
            const page = await pdfDoc.getPage(nextP);
            const renderScale = zoom * 2;
            const viewport = page.getViewport({ scale: renderScale });
            
            const cacheCanvas = document.createElement('canvas');
            cacheCanvas.width = viewport.width;
            cacheCanvas.height = viewport.height;
            cacheCanvas.style.width = `${viewport.width / (renderScale / zoom)}px`;
            cacheCanvas.style.height = `${viewport.height / (renderScale / zoom)}px`;
            
            const ctx = cacheCanvas.getContext('2d', { alpha: false });
            if (ctx) {
              await page.render({ canvasContext: ctx, viewport }).promise;
              const textContent = await page.getTextContent();
              
              pageCacheRef.current.set(nextP, { 
                canvas: cacheCanvas, 
                zoom, 
                textContent 
              });
              
              console.log(`[MediTrans] Prefetched page ${nextP}`);
              
              if (pageCacheRef.current.size > CACHE_SIZE_LIMIT) {
                const oldestKey = pageCacheRef.current.keys().next().value;
                if (oldestKey !== undefined) {
                  const old = pageCacheRef.current.get(oldestKey);
                  if (old?.canvas) {
                    old.canvas.width = 0;
                    old.canvas.height = 0;
                  }
                  pageCacheRef.current.delete(oldestKey);
                }
              }
            }
            page.cleanup();
          } catch (e) {
            console.warn("Predictive render failed:", e);
          }
        }, 3000); // Wait 3s after current page render to do background work
        return () => clearTimeout(timer);
      }
    }
  }, [pdfDoc, currentPage, renderPage, numPages, zoom]);

  const handleKeyDownRef = useRef<(e: KeyboardEvent) => void>(null);
  
  useEffect(() => {
    handleKeyDownRef.current = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullScreenRef.current) {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => setIsFullScreen(false));
        } else {
          setIsFullScreen(false);
        }
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          setIsAutoFit(false);
          setZoom(z => Math.min(3, Number((z + 0.1).toFixed(1))));
        } else if (e.key === '-') {
          e.preventDefault();
          setIsAutoFit(false);
          setZoom(z => Math.max(0.5, Number((z - 0.1).toFixed(1))));
        } else if (e.key === '0') {
          e.preventDefault();
          fitToWidthAction();
        }
      } else {
        // Arrow keys for navigation (only if not typing in an input)
        const activeElement = document.activeElement;
        const isTyping = activeElement?.tagName === 'INPUT' || activeElement?.tagName === 'TEXTAREA' || (activeElement as HTMLElement)?.isContentEditable;
        
        if (!isTyping) {
          if (e.key === 'ArrowLeft') {
            setCurrentPage(p => Math.max(1, p - 1));
          } else if (e.key === 'ArrowRight') {
            setCurrentPage(p => Math.min(numPages, p + 1));
          }
        }
      }
    };
  }, [numPages, fitToWidthAction]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (handleKeyDownRef.current) {
        handleKeyDownRef.current(e);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pdfDoc) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setIsAutoFit(false);
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        setZoom(prev => {
          const next = Math.min(3, Math.max(0.5, prev + delta));
          return Number(next.toFixed(1));
        });
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [pdfDoc]);

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!isDragging || !containerRef.current) return;
      e.preventDefault();
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      containerRef.current.scrollLeft = dragStart.scrollLeft - dx;
      containerRef.current.scrollTop = dragStart.scrollTop - dy;
    };

    const handleGlobalTouchMove = (e: TouchEvent) => {
      if (!isDragging || !containerRef.current || e.touches.length !== 1) return;
      // Prevent default to stop browser scrolling when panning
      e.preventDefault();
      const touch = e.touches[0];
      const dx = touch.clientX - dragStart.x;
      const dy = touch.clientY - dragStart.y;
      containerRef.current.scrollLeft = dragStart.scrollLeft - dx;
      containerRef.current.scrollTop = dragStart.scrollTop - dy;
    };

    const handleGlobalMouseUp = () => {
      if (isDragging) {
        setIsDragging(false);
        document.body.style.cursor = 'auto';
        if (containerRef.current) {
          containerRef.current.style.cursor = isPanning ? 'grab' : 'auto';
        }
      }
    };

    if (isDragging) {
      document.body.style.cursor = 'grabbing';
      window.addEventListener('mousemove', handleGlobalMouseMove);
      window.addEventListener('mouseup', handleGlobalMouseUp);
      window.addEventListener('touchmove', handleGlobalTouchMove, { passive: false });
      window.addEventListener('touchend', handleGlobalMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
      window.removeEventListener('touchmove', handleGlobalTouchMove);
      window.removeEventListener('touchend', handleGlobalMouseUp);
    };
  }, [isDragging, isPanning, dragStart]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isPanning || !containerRef.current) return;
    
    // Only handle left click
    if (e.button !== 0) return;

    setIsDragging(true);
    setDragStart({
      x: e.clientX,
      y: e.clientY,
      scrollLeft: containerRef.current.scrollLeft,
      scrollTop: containerRef.current.scrollTop
    });
    containerRef.current.style.cursor = 'grabbing';
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!isPanning || !containerRef.current || e.touches.length !== 1) return;

    const touch = e.touches[0];
    setIsDragging(true);
    setDragStart({
      x: touch.clientX,
      y: touch.clientY,
      scrollLeft: containerRef.current.scrollLeft,
      scrollTop: containerRef.current.scrollTop
    });
    containerRef.current.style.cursor = 'grabbing';
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    // Handle text selection for dictionary
    // Only trigger if lookup is enabled, translation panel is open and NOT in full screen mode
    if (!isLookupEnabled || !showTranslationPanel || isFullScreen) return;

    // Use a small timeout to ensure the selection is fully captured by the browser
    setTimeout(() => {
      const selection = window.getSelection();
      const selectedText = selection?.toString() || "";
      
      if (selectedText.trim().length > 0) {
        // Verify selection is within our target areas to avoid accidental triggers
        const anchorNode = selection?.anchorNode;
        if (!anchorNode) return;
        
        const targetElement = anchorNode instanceof Element ? anchorNode : anchorNode.parentElement;
        const isInsidePDF = targetElement?.closest('.textLayer');
        const isInsideTranslation = targetElement?.closest('.markdown-body');
        
        if (!isInsidePDF && !isInsideTranslation) return;

        // Clean the selected text: remove invisible characters and trim
        // We keep punctuation and internal spacing as the user wants the "exact" selection
        const text = selectedText
          .replace(/[\u00AD\u200B\u200C\u200D]/g, '') // Remove soft hyphens and zero-width spaces
          .trim();
        
        // Only trigger if it's not just whitespace
        const isNumeric = /^\d+$/.test(text);
        
        // Check if selection spans multiple lines by comparing rects
        let isSingleLine = true;
        try {
          const range = selection?.getRangeAt(0);
          if (range) {
            const rects = range.getClientRects();
            if (rects.length > 1) {
              // If multiple rects, check if they are on different vertical levels
              const firstRect = rects[0];
              for (let i = 1; i < rects.length; i++) {
                if (Math.abs(rects[i].top - firstRect.top) > 15) { // Slightly more tolerant
                  isSingleLine = false;
                  break;
                }
              }
            }
          }
        } catch (e) {}

        // Relax limits to allow longer phrases or short sentences (up to 200 chars, 20 words)
        const wordCount = text.split(/\s+/).length;
        // Allow slightly multi-line selections (up to 30px vertical difference)
        if (text.length > 1 && text.length < 200 && !isNumeric && wordCount <= 20) {
          try {
            const range = selection?.getRangeAt(0);
            if (range) {
              const rect = range.getBoundingClientRect();
              
              // Check if selection spans too many lines vertically
              let verticalSpan = 0;
              const rects = range.getClientRects();
              if (rects.length > 1) {
                let minTop = rects[0].top;
                let maxTop = rects[0].top;
                for (let i = 1; i < rects.length; i++) {
                  minTop = Math.min(minTop, rects[i].top);
                  maxTop = Math.max(maxTop, rects[i].top);
                }
                verticalSpan = maxTop - minTop;
              }

              // Only trigger if vertical span is reasonable (approx 2-3 lines max)
              if (verticalSpan < 60) {
                // Position relative to the viewport
                setDictionaryPosition({ x: rect.left, y: rect.bottom + 10 });
                setSelectedTerm(text);
              }
            }
          } catch (err) {
            // Range might be invalid if selection changed rapidly
          }
        }
      }
    }, 50);
  };

  const saveSettings = (keys: Record<TranslationEngine, string>) => {
    setEngineKeys(keys);
    localStorage.setItem('engine_keys', JSON.stringify(keys));
    setShowSettings(false);
  };

  const [copiedPage, setCopiedPage] = useState<number | null>(null);

  const handleCopyTranslation = (content: string, pageNum: number) => {
    navigator.clipboard.writeText(content);
    setCopiedPage(pageNum);
    setTimeout(() => setCopiedPage(null), 2000);
  };

  const clearAllTranslations = () => {
    setTranslations({});
    translationsRef.current = {};
    setActiveTranslation(null);
    setIsTranslating(false);
  };

  const [tempKeys, setTempKeys] = useState<Record<TranslationEngine, string>>(engineKeys);
  const [testStatus, setTestStatus] = useState<{ type: 'success' | 'error' | 'loading' | null, message: string }>({ type: null, message: '' });

  useEffect(() => {
    if (showSettings) {
      let currentKey = engineKeys[selectedEngine];
      if (user && selectedKeyId) {
        const vaultKey = userKeys.find(k => k.id === selectedKeyId);
        const currentEngineType = selectedEngine.startsWith('gemini') ? 'gemini' : selectedEngine;
        if (vaultKey && vaultKey.engine === currentEngineType) {
          currentKey = vaultKey.value;
        }
      }
      setTempKeys({ ...engineKeys, [selectedEngine]: currentKey });
    }
  }, [showSettings, engineKeys, user, selectedKeyId, userKeys, selectedEngine]);

  if (!isAuthReady) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-md bg-white rounded-[40px] shadow-2xl shadow-indigo-100/50 border border-slate-100 overflow-hidden p-10">
          <div className="flex flex-col items-center mb-10">
            <div className="w-20 h-20 bg-indigo-600 rounded-3xl flex items-center justify-center shadow-xl shadow-indigo-200 mb-6 rotate-3">
              <Logo className="w-12 h-12 text-white" />
            </div>
            <h1 className="text-3xl font-display font-black text-slate-800 tracking-tight text-center">MediTrans AI</h1>
            <p className="text-slate-400 font-bold text-sm mt-2 uppercase tracking-widest">Medical Translation System</p>
          </div>

          <div className="space-y-4">
            <button 
              onClick={() => {
                setAuthMode('login');
                setShowAuthModal(true);
              }}
              className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-bold shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition-all active:scale-95 flex items-center justify-center gap-3"
            >
              <LogIn className="w-5 h-5" />
              Đăng nhập để bắt đầu
            </button>
          </div>

          <div className="mt-10 pt-8 border-t border-slate-50 text-center">
            <p className="text-[10px] text-slate-300 font-black uppercase tracking-[0.3em]">
              Copyright © Dr. Hoang Hiep
            </p>
          </div>
        </div>

        {/* Auth Modal */}
        <AnimatePresence>
          {showAuthModal && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowAuthModal(false)}
                className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
              />
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="relative bg-white w-full max-w-md rounded-[40px] shadow-2xl overflow-hidden"
              >
                <div className="p-10">
                  <div className="flex items-center justify-between mb-8">
                    <h3 className="text-2xl font-display font-black text-slate-800">
                      Chào mừng trở lại
                    </h3>
                    <button onClick={() => setShowAuthModal(false)} className="p-2 hover:bg-slate-50 rounded-full transition-colors">
                      <ChevronLeft className="w-6 h-6 text-slate-400 rotate-180" />
                    </button>
                  </div>

                  <form onSubmit={handleEmailAuth} className="space-y-5">
                    <div>
                      <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Email</label>
                      <div className="relative">
                        <Languages className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-300" />
                        <input 
                          type="email"
                          required
                          value={authEmail}
                          onChange={(e) => setAuthEmail(e.target.value)}
                          className="w-full pl-12 pr-4 py-4 bg-slate-50 border border-slate-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all font-bold text-slate-700"
                          placeholder="bacsi@example.com"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Mật khẩu</label>
                      <div className="relative">
                        <ShieldCheck className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-300 pointer-events-none" />
                        <input 
                          type={showAuthPassword ? "text" : "password"}
                          required
                          value={authPassword}
                          onChange={(e) => setAuthPassword(e.target.value)}
                          className="w-full pl-12 pr-12 py-4 bg-slate-50 border border-slate-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all font-bold text-slate-700"
                          placeholder="••••••••"
                        />
                        <button
                          type="button"
                          onClick={() => setShowAuthPassword(!showAuthPassword)}
                          className="absolute right-4 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-indigo-600 transition-colors"
                        >
                          {showAuthPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                        </button>
                      </div>
                    </div>

                    {authError && (
                      <div className="p-4 bg-rose-50 border border-rose-100 rounded-2xl flex items-center gap-3 text-rose-600 text-xs font-bold animate-in fade-in slide-in-from-top-2">
                        <AlertCircle className="w-5 h-5 shrink-0" />
                        {authError}
                      </div>
                    )}

                    <button 
                      type="submit"
                      disabled={isLoggingIn}
                      className="w-full py-5 bg-indigo-600 text-white rounded-2xl font-black shadow-xl shadow-indigo-100 hover:bg-indigo-700 transition-all active:scale-95 flex items-center justify-center gap-3 disabled:opacity-50"
                    >
                      {isLoggingIn ? <Loader2 className="w-6 h-6 animate-spin" /> : 'Đăng nhập'}
                    </button>
                  </form>

                  <div className="mt-8 text-center">
                    <p className="text-xs font-bold text-slate-400">
                      Chưa có tài khoản? Vui lòng liên hệ quản trị viên.
                    </p>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className={cn(
        "h-screen flex flex-col bg-slate-50 overflow-hidden", 
        (isFullScreen || (pdfDoc && window.innerWidth < 768)) && "fixed inset-0 z-50"
      )}>
      {/* Key Check Notification */}
      <AnimatePresence>
        {keyCheckResults && (
          <motion.div 
            initial={{ opacity: 0, y: -50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -50 }}
            className="fixed top-20 left-1/2 -translate-x-1/2 z-[1000] w-full max-w-md px-4"
          >
            <div className="bg-white rounded-3xl shadow-2xl border border-slate-100 p-6 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="bg-indigo-100 p-2 rounded-xl">
                    <Key className="w-5 h-5 text-indigo-600" />
                  </div>
                  <div>
                    <h4 className="font-display font-black text-slate-800">Kiểm tra kết nối API</h4>
                    {keyCheckResults.totalActive !== undefined && (
                      <p className="text-[10px] font-black text-emerald-600 uppercase tracking-tighter">
                        Hoạt động: {keyCheckResults.totalActive}/{keyCheckResults.totalChecked}
                      </p>
                    )}
                  </div>
                </div>
                <button onClick={() => setKeyCheckResults(null)} className="p-1 hover:bg-slate-50 rounded-full">
                  <ChevronLeft className="w-5 h-5 text-slate-400 rotate-180" />
                </button>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-2xl border border-slate-100">
                  <div className="flex items-center gap-3">
                    <ShieldCheck className={cn("w-4 h-4", keyCheckResults.envKey ? "text-emerald-500" : "text-slate-300")} />
                    <span className="text-xs font-bold text-slate-700">Key Hệ thống (Environment)</span>
                  </div>
                  {keyCheckResults.envKey ? (
                    <span className="px-2 py-1 bg-emerald-100 text-emerald-600 text-[10px] font-black rounded-lg uppercase tracking-tighter">Kết nối thành công</span>
                  ) : (
                    <span className="px-2 py-1 bg-slate-200 text-slate-500 text-[10px] font-black rounded-lg uppercase tracking-tighter">Không khả dụng</span>
                  )}
                </div>

                {(keyCheckResults.manualKey || keyCheckResults.isVaultKey) && (
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-2xl border border-slate-100">
                    <div className="flex items-center gap-3">
                      <Key className={cn("w-4 h-4", (keyCheckResults.manualKey) ? "text-emerald-500" : "text-slate-300")} />
                      <span className="text-xs font-bold text-slate-700">
                        {keyCheckResults.isVaultKey ? `Key từ Vault (${keyCheckResults.vaultKeyName})` : 'Key Thủ công (Manual)'}
                      </span>
                    </div>
                    {keyCheckResults.manualKey ? (
                      <span className="px-2 py-1 bg-emerald-100 text-emerald-600 text-[10px] font-black rounded-lg uppercase tracking-tighter">Kết nối thành công</span>
                    ) : (
                      <span className="px-2 py-1 bg-rose-100 text-rose-600 text-[10px] font-black rounded-lg uppercase tracking-tighter">Lỗi kết nối</span>
                    )}
                  </div>
                )}
              </div>

              {!keyCheckResults.envKey && !keyCheckResults.manualKey && (
                <div className="p-3 bg-rose-50 border border-rose-100 rounded-2xl flex items-center gap-3 text-rose-600 text-[10px] font-bold">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  Không có API Key nào hoạt động. Vui lòng cấu hình trong Cài đặt.
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Header */}
      {(!isFullScreen && !(pdfDoc && window.innerWidth < 768)) && (
        <header className="h-14 border-b border-slate-200 bg-white flex items-center justify-between px-4 shrink-0 shadow-sm z-30">
          {file || pdfDoc ? (
            <button 
              onClick={clearFile}
              className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-500 mr-2"
              title="Quay lại quản lý file"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          ) : null}
          <LogoWithText />

        <div className="flex items-center gap-2">
          {pdfDoc && (
            <div className="hidden md:flex items-center bg-slate-50 rounded-full px-3 py-1 gap-2 border border-slate-100 max-w-[300px]">
              <FileText className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-xs font-medium text-slate-600 truncate">{currentFileName}</span>
            </div>
          )}
          
          <div className="h-6 w-px bg-slate-200 mx-1 hidden md:block" />
          
          {pdfDoc && (
            <button 
              onClick={clearFile}
              className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-slate-100 text-slate-500 hover:text-indigo-600 rounded-full transition-all text-[10px] font-bold uppercase tracking-wider"
              title="Đóng tài liệu hiện tại"
            >
              <X className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Đóng file</span>
            </button>
          )}

          {userRole === 'admin' && (
            <button 
              onClick={() => {
                setShowAdminPanel(true);
                fetchAllUsers();
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 text-white rounded-full transition-all text-[10px] font-bold uppercase tracking-wider shadow-sm hover:bg-amber-600"
              title="Quản trị hệ thống"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Quản trị</span>
            </button>
          )}

          <button 
            onClick={() => setShowSettings(true)}
            className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-500"
            title="Cài đặt API Key"
          >
            <Settings className="w-4 h-4" />
          </button>

          <button 
            onClick={() => {
              const nextState = !showTranslationPanel;
              setShowTranslationPanel(nextState);
              if (!nextState) setSelectedTerm(null);
              
              // On mobile, also update mobileViewMode for better sync
              if (window.innerWidth < 768) {
                setMobileViewMode(nextState ? 'split' : 'pdf');
              }
            }}
            className={cn(
              "p-2 rounded-full transition-all",
              showTranslationPanel ? "bg-indigo-50 text-indigo-600 shadow-sm" : "hover:bg-slate-100 text-slate-500"
            )}
            title={showTranslationPanel ? "Đóng Tra cứu & Dịch thuật" : "Mở Tra cứu & Dịch thuật"}
          >
            <Languages className="w-4 h-4" />
          </button>
          
          <button 
            onClick={toggleFullScreen}
            className={cn(
              "p-2 rounded-full transition-all",
              isFullScreen ? "bg-indigo-600 text-white shadow-lg shadow-indigo-100" : "hover:bg-slate-100 text-slate-500"
            )}
            title={isFullScreen ? "Thoát toàn màn hình" : "Toàn màn hình (F11)"}
          >
            {isFullScreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>

          <div className="h-6 w-px bg-slate-200 mx-1" />

          {isAuthReady && (
            user ? (
              <div className="flex items-center gap-2 pl-1">
                <div className="hidden lg:flex flex-col items-end mr-1">
                  <span className="text-[10px] font-bold text-slate-700 leading-none">{user.displayName || 'Người dùng'}</span>
                  <span className="text-[8px] text-slate-400 font-medium">{user.email}</span>
                </div>
                <div className="relative group">
                  <img 
                    src={user.photoURL || `https://ui-avatars.com/api/?name=${user.displayName || 'User'}&background=6366f1&color=fff`} 
                    alt="Avatar" 
                    className="w-8 h-8 rounded-full border-2 border-white shadow-sm cursor-pointer"
                    referrerPolicy="no-referrer"
                  />
                  <div className="absolute right-0 top-full mt-2 w-48 bg-white rounded-2xl shadow-xl border border-slate-100 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 p-2">
                    <div className="px-3 py-2 border-b border-slate-50 mb-1">
                      <p className="text-xs font-bold text-slate-800 truncate">{user.displayName}</p>
                      <p className="text-[10px] text-slate-400 truncate">{user.email}</p>
                    </div>
                    <button 
                      onClick={handleLogout}
                      className="w-full flex items-center gap-2 px-3 py-2 text-rose-500 hover:bg-rose-50 rounded-xl transition-colors text-xs font-bold"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      Đăng xuất
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <button 
                onClick={() => setShowAuthModal(true)}
                className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-1.5 rounded-full text-xs font-bold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 active:scale-95"
              >
                <LogIn className="w-3.5 h-3.5" />
                Đăng nhập
              </button>
            )
          )}
        </div>
      </header>
      )}

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden relative bg-slate-50">
        <UploadStatus tasks={uploadTasks} onDismiss={dismissUploadTask} />
        {showExplorer ? (
          <div className="flex-1 p-4 sm:p-8 overflow-hidden">
            <FileExplorer 
              onFileSelect={handleFileSelectFromExplorer} 
              onUploadStart={startUpload} 
              onLocalFileOpen={handleLocalFileOpen}
            />
          </div>
        ) : (
          <div className="flex-1 flex flex-col md:flex-row divide-y md:divide-y-0 md:divide-x divide-slate-200 min-h-0 w-full overflow-hidden relative">
            {/* Left Side: Original PDF */}
            <div className={cn(
              "flex flex-col bg-slate-100 overflow-hidden border-r border-slate-200 transition-all duration-300 ease-in-out relative",
              isFullScreen ? "w-1/2" : (showTranslationPanel ? "w-full md:w-1/2" : "w-full"),
              mobileViewMode === 'pdf' ? "flex h-full" : (mobileViewMode === 'split' ? "flex h-[45%] shrink-0 md:h-full" : "hidden md:flex")
            )}>
              <div className="h-11 bg-white border-b border-slate-200 flex items-center justify-between px-3 shrink-0 z-20 shadow-sm overflow-x-auto no-scrollbar">
                <div className="flex items-center gap-3 min-w-max">
                  <div className="flex items-center gap-1.5">
                    {isLocalOnly && (
                      <button 
                        onClick={() => setShowFolderSelectModal(true)}
                        className="flex items-center gap-1.5 px-3 py-1 bg-amber-500 text-white text-[10px] font-bold rounded-full hover:bg-amber-600 transition-all shadow-sm ml-2"
                        title="Tải tệp này lên đám mây để lưu trữ"
                      >
                        <Upload className="w-3 h-3" />
                        <span>TẢI LÊN ĐÁM MÂY</span>
                      </button>
                    )}

                    {isFullScreen && (
                      <button 
                        onClick={toggleFullScreen}
                        className="flex items-center gap-1 px-2 py-0.5 bg-indigo-600 text-white text-[10px] font-bold rounded-full hover:bg-indigo-700 transition-all shadow-sm ml-2"
                      >
                        <Minimize2 className="w-3 h-3" />
                        <span>THOÁT TOÀN MÀN HÌNH</span>
                      </button>
                    )}

                    {fileUrl && !isLocalOnly && (
                      <a 
                        href={fileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 px-3 py-1 bg-emerald-500 text-white text-[10px] font-bold rounded-full hover:bg-emerald-600 transition-all shadow-sm ml-2"
                        title="Tải tệp PDF gốc về máy"
                      >
                        <Download className="w-3 h-3" />
                        <span>TẢI PDF GỐC</span>
                      </a>
                    )}

                    {/* Mobile Actions - Settings & Close */}
                    <div className="flex md:hidden items-center gap-0.5 mr-2">
                      <button 
                        onClick={() => setShowSettings(true)}
                        className="p-1.5 text-slate-400 active:text-indigo-600 transition-colors"
                        title="Cài đặt"
                      >
                        <Settings className="w-3.5 h-3.5" />
                      </button>
                      <button 
                        onClick={clearFile}
                        className="p-1.5 text-slate-400 active:text-indigo-600 transition-colors"
                        title="Đóng PDF"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Mobile Navigation - Removed as redundant with floating bar */}
                    <div className="hidden md:flex items-center gap-0.5 bg-slate-50 rounded-lg px-1.5 py-0.5 border border-slate-100">
                      {/* Navigation Logic Consolidated Below */}
                    </div>
                  </div>

                  <div className="h-4 w-px bg-slate-200 hidden xs:block" />

                  <div className="flex items-center gap-0.5">
                    <button 
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="p-1 hover:bg-slate-100 rounded-md disabled:opacity-20 transition-colors"
                    >
                      <ChevronLeft className="w-3.5 h-3.5 md:w-4 md:h-4 text-slate-600" />
                    </button>
                    <div className="flex items-center gap-1 px-1">
                      <input 
                        type="number" 
                        min={1} 
                        max={numPages}
                        value={currentPage}
                        onChange={(e) => {
                          const val = parseInt(e.target.value);
                          if (!isNaN(val) && val >= 1 && val <= numPages) {
                            setCurrentPage(val);
                          }
                        }}
                        className="w-8 md:w-9 h-5 md:h-6 text-center text-[10px] md:text-[11px] font-bold border border-slate-200 rounded bg-slate-50 focus:bg-white focus:ring-1 focus:ring-indigo-500 transition-all px-0"
                      />
                      <span className="text-[9px] md:text-[10px] font-bold text-slate-400">/ {numPages}</span>
                    </div>
                    <button 
                      onClick={() => setCurrentPage(p => Math.min(numPages, p + 1))}
                      disabled={currentPage === numPages}
                      className="p-1 hover:bg-slate-100 rounded-md disabled:opacity-20 transition-colors"
                    >
                      <ChevronRight className="w-3.5 h-3.5 md:w-4 md:h-4 text-slate-600" />
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-3 min-w-max ml-4">
                  <div className="flex items-center gap-0.5 bg-slate-50 rounded-lg p-0.5 border border-slate-100">
                    <button 
                      onClick={() => setIsPanning(!isPanning)}
                      className={cn(
                        "p-1.5 rounded transition-all",
                        isPanning ? "bg-indigo-600 text-white shadow-md" : "hover:bg-white text-slate-500"
                      )}
                      title={isPanning ? "Tắt Hand Tool" : "Bật Hand Tool (Di chuyển)"}
                    >
                      <Hand className="w-3.5 h-3.5" />
                    </button>
                    <div className="w-px h-3 bg-slate-200 mx-0.5" />
                    <button 
                      onClick={() => {
                        const nextState = !isLookupEnabled;
                        setIsLookupEnabled(nextState);
                        if (!nextState) setSelectedTerm(null);
                      }}
                      className={cn(
                        "p-1.5 rounded transition-all",
                        isLookupEnabled ? "bg-indigo-600 text-white shadow-md" : "hover:bg-white text-slate-500"
                      )}
                      title={isLookupEnabled ? "Tắt Tra cứu nhanh" : "Bật Tra cứu nhanh (Bôi đen để dịch)"}
                    >
                      <Search className="w-3.5 h-3.5" />
                    </button>
                    <div className="w-px h-3 bg-slate-200 mx-0.5" />
                    <button 
                      onClick={() => {
                        setIsAutoFit(false);
                        setZoom(z => Math.max(0.5, z - 0.1));
                      }} 
                      className="p-1.5 hover:bg-white hover:shadow-sm rounded transition-all text-slate-500"
                    >
                      <ZoomOut className="w-3.5 h-3.5" />
                    </button>
                    <span className="text-[10px] font-black font-mono text-slate-600 w-9 text-center">
                      {Math.round(zoom * 100)}%
                    </span>
                    <button 
                      onClick={() => {
                        setIsAutoFit(false);
                        setZoom(z => Math.min(3, z + 0.1));
                      }} 
                      className="p-1.5 hover:bg-white hover:shadow-sm rounded transition-all text-slate-500"
                    >
                      <ZoomIn className="w-3.5 h-3.5" />
                    </button>
                    <button 
                      onClick={fitToWidthAction} 
                      className={cn(
                        "p-1.5 rounded transition-all ml-0.5",
                        isAutoFit ? "bg-indigo-600 text-white shadow-md" : "hover:bg-white text-slate-500"
                      )}
                      title="Vừa khít chiều rộng"
                    >
                      <Maximize className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>
              <div 
                className={cn(
                  "flex-1 overflow-auto pdf-container relative bg-slate-100 pb-52 md:pb-8",
                  isFullScreen ? "p-0" : "p-4 md:p-8",
                  isPanning ? "cursor-grab select-none touch-none" : "cursor-auto"
                )} 
                ref={containerRef}
                onMouseDown={handleMouseDown}
                onTouchStart={handleTouchStart}
              >
                <div className="inline-block min-w-full text-center align-top">
                  {!pdfDoc && isPdfLoading ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-4">
                      <div className="relative">
                        <div className="w-16 h-16 border-4 border-indigo-100 border-t-indigo-600 rounded-full animate-spin" />
                        <FileText className="absolute inset-0 m-auto w-6 h-6 text-indigo-600" />
                      </div>
                      <div className="text-center">
                        <p className="text-sm font-bold text-slate-700">Đang tải tài liệu...</p>
                        <p className="text-xs text-slate-400">Vui lòng đợi trong giây lát</p>
                      </div>
                    </div>
                  ) : (
                    <div className={cn(
                      "inline-block text-left relative shadow-2xl bg-white overflow-hidden shrink-0 transition-all duration-300",
                      isFullScreen ? "my-0 rounded-none border-none" : "my-8 rounded-lg border border-slate-200"
                    )}>
                      {(isPdfLoading || isRendering) && (
                        <div className="absolute inset-0 flex items-center justify-center bg-slate-200/30 z-20">
                          <div className="flex flex-col items-center gap-2">
                            <Loader2 className="w-10 h-10 text-indigo-600 animate-spin" />
                          </div>
                        </div>
                      )}
                      {pdfError && (
                        <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-20 p-4 text-center">
                          <div className="max-w-xs">
                            <AlertCircle className="w-10 h-10 text-rose-500 mx-auto mb-2" />
                            <p className="text-sm font-bold text-slate-800">{pdfError}</p>
                          </div>
                        </div>
                      )}
                      <canvas 
                        ref={canvasRef} 
                        className={cn(
                          "transition-opacity duration-200 relative z-0 block", 
                          (isPdfLoading || isRendering) ? "opacity-50" : "opacity-100"
                        )} 
                      />
                      <div 
                        ref={textLayerRef}
                        className="absolute inset-0 textLayer pointer-events-auto z-10"
                        onMouseUp={handleMouseUp}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Right Side: Translation */}
            <motion.div 
              initial={{ x: 300, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 300, opacity: 0 }}
              className={cn(
                "flex flex-col bg-white overflow-hidden transition-all duration-300",
                isFullScreen ? "flex w-1/2" : (mobileViewMode === 'translation' ? "flex h-full" : (mobileViewMode === 'split' ? "flex h-[55%] border-t-2 border-slate-200 md:h-full md:border-t-0" : (showTranslationPanel ? "hidden md:flex w-1/2" : "hidden")))
              )}
            >
              <div className="h-11 border-b border-slate-200 flex items-center justify-between px-3 shrink-0 z-20 shadow-sm overflow-x-auto no-scrollbar">
                <div className="flex items-center gap-3 min-w-max">
                  <div className="flex items-center gap-2">
                    <div className="flex md:hidden items-center gap-0.5 mr-1">
                      <button 
                        onClick={() => setShowSettings(true)}
                        className="p-1.5 text-slate-400 active:text-indigo-600 transition-colors"
                      >
                        <Settings className="w-3.5 h-3.5" />
                      </button>
                      <button 
                        onClick={clearFile}
                        className="p-1.5 text-slate-400 active:text-indigo-600 transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="flex items-center gap-1 p-1 bg-slate-100/50 rounded-lg border border-slate-200/50">
                      <button 
                        onClick={() => setTranslationPanelMode('translation')}
                        className={cn(
                          "flex items-center gap-1.5 px-2 py-1 rounded-md transition-all text-[10px] font-black uppercase tracking-tight",
                          translationPanelMode === 'translation' ? "bg-white shadow-sm text-indigo-600" : "text-slate-400 hover:text-slate-600"
                        )}
                      >
                        <Languages className="w-3 h-3" />
                        <span>Dịch</span>
                      </button>
                      <button 
                        onClick={() => setTranslationPanelMode('summary')}
                        className={cn(
                          "flex items-center gap-1.5 px-2 py-1 rounded-md transition-all text-[10px] font-black uppercase tracking-tight",
                          translationPanelMode === 'summary' ? "bg-white shadow-sm text-indigo-600" : "text-slate-400 hover:text-slate-600"
                        )}
                      >
                        <ScrollText className="w-3 h-3" />
                        <span>Tóm tắt</span>
                      </button>
                    </div>
                  </div>
                  
                  <div className="h-4 w-px bg-slate-200" />
                  
                  {isTranslating && (
                    <button 
                      onClick={cancelTranslation}
                      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-rose-50 border border-rose-100 text-rose-600 hover:bg-rose-100 transition-all"
                      title="Dừng dịch thuật"
                    >
                      <Square className="w-2.5 h-2.5 fill-current" />
                      <span className="text-[9px] font-black uppercase tracking-tight">Dừng</span>
                    </button>
                  )}

                  {isTranslating && <div className="h-4 w-px bg-slate-200" />}

                  <button 
                    onClick={() => setAutoTranslate(!autoTranslate)}
                    className={cn(
                      "flex items-center gap-1.5 px-2 py-0.5 rounded-full transition-all border",
                      autoTranslate 
                        ? "bg-emerald-50 border-emerald-100 text-emerald-600" 
                        : "bg-slate-50 border-slate-100 text-slate-400 hover:text-slate-500"
                    )}
                    title="Tự động dịch khi chuyển trang"
                  >
                    <div className={cn(
                      "w-1.5 h-1.5 rounded-full",
                      autoTranslate ? "bg-emerald-500 animate-pulse" : "bg-slate-300"
                    )} />
                    <span className="text-[9px] font-black uppercase tracking-tight">Auto</span>
                  </button>

                  <div className="h-4 w-px bg-slate-200" />
                </div>
                
                <div className="flex items-center gap-1.5 md:gap-3 min-w-max ml-0 md:ml-4 flex-wrap pb-2 md:pb-0">
                  <button 
                    onClick={() => {
                      if (translations[currentPage]?.status === 'success') {
                        setSelectedPagesToDownload([currentPage]);
                      } else {
                        setSelectedPagesToDownload([]);
                      }
                      setShowDownloadModal(true);
                    }}
                    className="flex items-center gap-1.5 px-2 md:px-3 py-1.5 rounded-xl text-[9px] md:text-[10px] font-black text-indigo-600 bg-indigo-50 hover:bg-indigo-100 uppercase tracking-tighter transition-all border border-indigo-100 shadow-sm"
                  >
                    <Download className="w-3 h-3 md:w-3.5 md:h-3.5" /> 
                    <span>Tải tập tin</span>
                  </button>

                  <div className="h-4 w-px bg-slate-200 hidden xs:block" />

                  {translationPanelMode === 'translation' ? (
                    <button 
                      onClick={() => translateCurrentPage(currentPage, true)}
                      disabled={isTranslating || isRendering}
                      className={cn(
                        "px-3 md:px-5 py-1.5 rounded-xl text-[9px] md:text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 md:gap-2 shadow-lg",
                        (isTranslating || isRendering)
                          ? "bg-slate-100 text-slate-400 cursor-not-allowed shadow-none" 
                          : "bg-indigo-600 text-white hover:bg-indigo-700 shadow-indigo-200 hover:shadow-indigo-300 active:scale-95"
                      )}
                    >
                      {isTranslating || isRendering ? (
                        <>
                          <Loader2 className="w-3 h-3 md:w-3.5 md:h-3.5 animate-spin" />
                          <span>{isRendering ? 'Vẽ...' : 'Dịch...'}</span>
                        </>
                      ) : (
                        <>
                          <RefreshCcw className="w-3 h-3 md:w-3.5 md:h-3.5" />
                          <span>{translations[currentPage] ? 'Dịch lại' : 'Dịch trang'}</span>
                        </>
                      )}
                    </button>
                  ) : (
                    <div className="flex items-center gap-1.5 bg-slate-100/50 p-1 rounded-2xl border border-slate-200/50">
                      <button 
                        onClick={() => handleSummarize('page')}
                        disabled={isSummarizing}
                        className={cn(
                          "px-2 md:px-3 py-1.5 rounded-xl text-[9px] md:text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 md:gap-2",
                          isSummarizing 
                            ? "text-slate-400 opacity-50" 
                            : "bg-white text-indigo-600 shadow-sm hover:bg-indigo-50"
                        )}
                        title="Tóm tắt trang hiện tại"
                      >
                        {isSummarizing ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <FileSearch className="w-3.5 h-3.5" />
                        )}
                        <span className="hidden sm:inline">Trang</span>
                      </button>

                      <div className="flex items-center gap-1 px-1 bg-white/60 rounded-lg border border-slate-200 shadow-inner group transition-all focus-within:ring-2 focus-within:ring-indigo-100">
                        <input 
                          type="number" 
                          min={1} 
                          max={numPages} 
                          value={summaryRange.from} 
                          onChange={(e) => setSummaryRange(prev => ({ ...prev, from: parseInt(e.target.value) || 1 }))}
                          className="w-7 md:w-8 text-[10px] font-black bg-transparent border-none p-0 text-center text-slate-600 focus:ring-0"
                          title="Trang bắt đầu"
                        />
                        <span className="text-[10px] font-black text-slate-400">→</span>
                        <input 
                          type="number" 
                          min={1} 
                          max={numPages} 
                          value={summaryRange.to} 
                          onChange={(e) => setSummaryRange(prev => ({ ...prev, to: parseInt(e.target.value) || 1 }))}
                          className="w-7 md:w-8 text-[10px] font-black bg-transparent border-none p-0 text-center text-slate-600 focus:ring-0"
                          title="Trang kết thúc"
                        />
                        <button 
                          onClick={() => handleSummarize('chapter')}
                          disabled={isSummarizing}
                          className={cn(
                            "ml-1 p-1.5 rounded-lg transition-all",
                            isSummarizing 
                              ? "text-slate-300" 
                              : "text-indigo-600 hover:bg-indigo-50 active:scale-90"
                          )}
                          title="Tóm tắt khoảng tùy chọn"
                        >
                          <Layout className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      
                      <button 
                        onClick={() => handleSummarize('document')}
                        disabled={isSummarizing}
                        className={cn(
                          "px-2 md:px-3 py-1.5 rounded-xl text-[9px] md:text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 md:gap-2",
                          isSummarizing 
                            ? "text-slate-400 opacity-50" 
                            : "bg-white text-indigo-600 shadow-sm hover:bg-indigo-50"
                        )}
                        title="Tóm tắt toàn bộ tài liệu"
                      >
                        <BookOpen className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Tài liệu</span>
                      </button>
                    </div>
                  )}

                  <div className="h-4 w-px bg-slate-200 hidden xs:block" />

                  {(translationPanelMode === 'translation' ? translations[currentPage]?.content : summaryText) && (
                    <div className="flex items-center gap-1.5">
                      <button 
                        onClick={() => handleCopyTranslation(translationPanelMode === 'translation' ? translations[currentPage].content : summaryText, currentPage)}
                        className={cn(
                          "p-2 border rounded-xl transition-all flex items-center gap-1.5 shadow-sm",
                          copiedPage === currentPage 
                            ? "bg-emerald-50 border-emerald-200 text-emerald-600" 
                            : "bg-white border-slate-200 text-slate-400 hover:text-indigo-600 hover:border-indigo-100 hover:bg-indigo-50/30"
                        )}
                        title="Sao chép"
                      >
                        {copiedPage === currentPage ? (
                          <>
                            <Check className="w-3.5 h-3.5" />
                            <span className="hidden xs:inline text-[9px] font-black uppercase tracking-wider">Đã chép!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span className="hidden xs:inline text-[9px] font-black uppercase tracking-wider text-slate-400">Chép</span>
                          </>
                        )}
                      </button>

                      {translationPanelMode === 'summary' && summaryText && (
                        <>
                          <button 
                            onClick={handleSaveSummary}
                            disabled={isSavingSummary || isSummarizing}
                            className="p-2 border border-slate-200 rounded-xl bg-white text-slate-400 hover:text-indigo-600 hover:border-indigo-100 hover:bg-indigo-50/30 transition-all flex items-center gap-1.5 shadow-sm disabled:opacity-50"
                            title="Lưu tóm tắt vào đám mây"
                          >
                            {isSavingSummary ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                            <span className="hidden xs:inline text-[9px] font-black uppercase tracking-wider">Lưu</span>
                          </button>
                          <button 
                            onClick={handleDownloadSummary}
                            className="p-2 border border-slate-200 rounded-xl bg-white text-slate-400 hover:text-indigo-600 hover:border-indigo-100 hover:bg-indigo-50/30 transition-all flex items-center gap-1.5 shadow-sm"
                            title="Tải xuống tóm tắt"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span className="hidden xs:inline text-[9px] font-black uppercase tracking-wider text-slate-400">Tải</span>
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  <div className="h-4 w-px bg-slate-200 hidden md:block" />

                  {/* Font Controls at the end */}
                  <div className="flex items-center gap-1.5 bg-slate-50 rounded-md p-0.5 border border-slate-100">
                    <div className="flex items-center gap-1 px-1">
                      <FontIcon className="w-3 h-3 text-slate-400" />
                      <select 
                        value={fontFamily}
                        onChange={(e) => setFontFamily(e.target.value)}
                        className="text-[10px] font-bold bg-transparent border-none focus:ring-0 cursor-pointer text-slate-600 px-0"
                      >
                        <option value="Inter">Sans</option>
                        <option value="Cormorant Garamond">Serif</option>
                        <option value="Playfair Display">Display</option>
                        <option value="JetBrains Mono">Mono</option>
                      </select>
                    </div>
                    
                    <div className="w-px h-3 bg-slate-200 mx-0.5" />
                    
                    <div className="flex items-center gap-1 px-1">
                      <ALargeSmall className="w-3 h-3 text-slate-400" />
                      <select 
                        value={fontSize}
                        onChange={(e) => setFontSize(Number(e.target.value))}
                        className="text-[10px] font-bold bg-transparent border-none focus:ring-0 cursor-pointer text-slate-600 px-0"
                      >
                        {[12, 14, 16, 18, 20].map(size => (
                          <option key={size} value={size}>{size}px</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </div>
              
              <div className="flex-1 overflow-auto p-6 md:p-12 bg-white">
                <AnimatePresence mode="wait">
                  {translationPanelMode === 'summary' ? (
                    <motion.div 
                      key="summary-view"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="h-full flex flex-col"
                    >
                      {!summaryText && !isSummarizing ? (
                        <div className="h-full flex flex-col items-center justify-center text-slate-400 text-center">
                          <ScrollText className="w-12 h-12 mb-4 opacity-20" />
                          <p className="text-sm font-medium">Chưa có tóm tắt.</p>
                          <p className="text-xs">Chọn chế độ tóm tắt để bắt đầu.</p>
                        </div>
                      ) : (
                        <div 
                          className="markdown-body select-text pb-60 md:pb-0"
                          style={{ fontSize: `${fontSize}px` }}
                        >
                          {isSummarizing && !summaryText && (
                            <div className="flex flex-col items-center justify-center py-20 gap-4">
                              <Loader2 className="w-10 h-10 text-indigo-600 animate-spin" />
                              <p className="text-xs font-bold text-slate-500 animate-pulse uppercase tracking-wider">Đang khởi tạo tóm tắt...</p>
                            </div>
                          )}
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {summaryText}
                          </ReactMarkdown>
                          {isSummarizing && summaryText && (
                            <div className="mt-4 flex items-center gap-2 text-indigo-600 font-bold text-xs animate-pulse">
                              <Loader2 className="w-4 h-4 animate-spin" />
                              <span>Đang tóm tắt nội dung...</span>
                            </div>
                          )}
                        </div>
                      )}
                    </motion.div>
                  ) : (
                    // Translation Mode Content
                    (!translations[currentPage] && (!activeTranslation || activeTranslation.page !== currentPage)) ? (
                      (isRendering || isPdfLoading) ? (
                      <motion.div 
                        key="rendering"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="h-full flex flex-col items-center justify-center text-slate-400 text-center"
                      >
                        <Loader2 className="w-12 h-12 mb-4 text-indigo-400 animate-spin" />
                        <p className="text-sm font-medium">Đang chuẩn bị trang...</p>
                        <p className="text-xs">Vui lòng đợi trong giây lát</p>
                      </motion.div>
                    ) : (
                      <motion.div 
                        key="empty"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="h-full flex flex-col items-center justify-center text-slate-400 text-center"
                      >
                        <Search className="w-12 h-12 mb-4 opacity-20" />
                        <p className="text-sm font-medium">Chưa có bản dịch cho trang này.</p>
                        <p className="text-xs">Nhấn "Dịch trang này" để bắt đầu.</p>
                      </motion.div>
                    )
                  ) : (translations[currentPage]?.status === 'loading' && !translations[currentPage].content && (!activeTranslation || activeTranslation.page !== currentPage)) ? (
                    <motion.div 
                      key="loading"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="h-full flex flex-col items-center justify-center gap-4"
                    >
                      <div className="relative">
                        <div className="w-12 h-12 border-4 border-indigo-100 border-t-indigo-600 rounded-full animate-spin" />
                        <Languages className="absolute inset-0 m-auto w-5 h-5 text-indigo-600" />
                      </div>
                      <div className="text-center">
                        <p className="text-sm font-bold text-slate-700">Đang phân tích y khoa...</p>
                        <p className="text-xs text-slate-400 mb-4">Gemini đang xử lý hình ảnh và văn bản</p>
                        <button 
                          onClick={cancelTranslation}
                          className="px-4 py-2 bg-slate-100 text-slate-600 rounded-xl text-xs font-bold hover:bg-rose-50 hover:text-rose-600 transition-all border border-slate-200"
                        >
                          Dừng dịch
                        </button>
                      </div>
                    </motion.div>
                  ) : translations[currentPage]?.status === 'error' ? (
                    <motion.div 
                      key="error"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="h-full flex flex-col items-center justify-center gap-4 text-rose-500 bg-rose-50 rounded-2xl p-8"
                    >
                      <AlertCircle className="w-12 h-12" />
                      <p className="text-sm font-bold text-center leading-relaxed">
                        {translations[currentPage].content}
                      </p>
                      
                      {translations[currentPage].content?.includes('hết hạn mức') && (
                        <div className="bg-white/50 p-3 rounded-xl border border-rose-200 mt-2 text-center">
                          <p className="text-[11px] font-medium mb-2">Hệ thống gợi ý:</p>
                          <p className="text-[10px] italic">Thêm nhiều Key trong Cài đặt để tự động luân phiên tránh lỗi này.</p>
                        </div>
                      )}

                      <div className="flex flex-wrap justify-center gap-3">
                        <button 
                          onClick={() => setShowSettings(true)}
                          className="px-5 py-2.5 bg-rose-600 text-white rounded-2xl text-xs font-bold hover:bg-rose-700 transition-all shadow-lg shadow-rose-200 flex items-center gap-2"
                        >
                          <Settings className="w-3.5 h-3.5" />
                          Cấu hình lại Key
                        </button>
                        <button 
                          onClick={() => translateCurrentPage(currentPage, true)}
                          className="px-5 py-2.5 bg-white border border-rose-200 text-rose-600 rounded-2xl text-xs font-bold hover:bg-rose-100 transition-all"
                        >
                          Thử lại
                        </button>
                      </div>
                      
                      {(window as any).aistudio?.openSelectKey && (
                        <button 
                          onClick={async () => {
                            if (translationService.current instanceof GeminiService) {
                              await (translationService.current as any).openKeySelection();
                              translateCurrentPage(currentPage, true);
                            }
                          }}
                          className="mt-2 text-[10px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-700 underline underline-offset-4"
                        >
                          Chọn Key từ AI Studio
                        </button>
                      )}
                    </motion.div>
                  ) : (
                    <motion.div 
                      key="content"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="markdown-body select-text pb-60 md:pb-0"
                      onMouseUp={handleMouseUp}
                      style={{ 
                        fontSize: `${fontSize}px`,
                        fontFamily: fontFamily === 'Inter' ? 'var(--font-sans)' : 
                                   fontFamily === 'JetBrains Mono' ? 'var(--font-mono)' : 
                                   fontFamily === 'Playfair Display' ? 'var(--font-display)' :
                                   fontFamily === 'Cormorant Garamond' ? 'var(--font-serif)' :
                                   fontFamily
                      }}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {activeTranslation && activeTranslation.page === currentPage 
                          ? activeTranslation.content 
                          : translations[currentPage]?.content || ''}
                      </ReactMarkdown>

                      {activeTranslation && activeTranslation.page === currentPage && (
                        <div className="mt-6 p-4 bg-indigo-50/50 rounded-2xl border border-indigo-100/50 flex flex-col gap-3">
                          <div className="flex items-center gap-2 text-indigo-600 font-bold text-xs animate-pulse">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Đang dịch nội dung y khoa...</span>
                          </div>
                          <button 
                            onClick={cancelTranslation}
                            className="w-fit px-4 py-2 bg-white text-slate-600 rounded-xl text-[10px] font-black uppercase tracking-wider hover:bg-rose-50 hover:text-rose-600 transition-all border border-slate-200 shadow-sm flex items-center gap-2"
                          >
                            <Square className="w-3 h-3 fill-current" />
                            Dừng dịch
                          </button>
                        </div>
                      )}

                      {/* Mobile Navigation Buttons - Removed as redundant with floating bar */}
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </motion.div>
          </div>
        )}
      </main>

      {/* Tablet Navigation Buttons */}
      {pdfDoc && !showSettings && !showAuthModal && (
        <div className="fixed bottom-6 md:bottom-8 left-0 right-0 pointer-events-none z-40 hidden md:flex justify-between px-4 md:px-12">
          <button 
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            disabled={currentPage === 1 || isPdfLoading || isRendering}
            className={cn(
              "pointer-events-auto w-12 h-12 md:w-14 md:h-14 rounded-full flex items-center justify-center shadow-2xl transition-all active:scale-90 border backdrop-blur-sm",
              (currentPage === 1 || isPdfLoading || isRendering)
                ? "bg-slate-50/80 text-slate-200 border-slate-100 cursor-not-allowed" 
                : "bg-white/90 text-indigo-600 hover:bg-indigo-50 border-indigo-100 hover:shadow-indigo-100"
            )}
            title="Trang trước"
          >
            <ChevronLeft className="w-6 h-6 md:w-8 md:h-8" />
          </button>
          
          <button 
            onClick={() => setCurrentPage(p => Math.min(numPages, p + 1))}
            disabled={currentPage === numPages || isPdfLoading || isRendering}
            className={cn(
              "pointer-events-auto w-12 h-12 md:w-14 md:h-14 rounded-full flex items-center justify-center shadow-2xl transition-all active:scale-90 border backdrop-blur-sm",
              (currentPage === numPages || isPdfLoading || isRendering)
                ? "bg-slate-50/80 text-slate-200 border-slate-100 cursor-not-allowed" 
                : "bg-indigo-600/90 text-white hover:bg-indigo-700 border-indigo-500 shadow-indigo-200 hover:shadow-indigo-300"
            )}
            title="Trang tiếp theo"
          >
            <ChevronRight className="w-6 h-6 md:w-8 md:h-8" />
          </button>
        </div>
      )}

      {/* Dictionary Pop-up */}
      {selectedTerm && (
        <MedicalDictionary 
          selectedTerm={selectedTerm}
          onClose={() => setSelectedTerm(null)}
          translationService={translationService.current}
          position={dictionaryPosition}
        />
      )}

      {/* Auth Modal */}
      <AnimatePresence>
        {showAuthModal && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowAuthModal(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-8 overflow-y-auto no-scrollbar">
                <div className="text-center mb-8">
                  <div className="bg-indigo-600 w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-indigo-200">
                    <UserIcon className="text-white w-6 h-6" />
                  </div>
                  <h3 className="text-2xl font-display font-bold text-slate-800">
                    Chào mừng trở lại
                  </h3>
                  <p className="text-slate-500 text-sm mt-1">
                    Đăng nhập để quản lý API Key của bạn
                  </p>
                </div>

                <form onSubmit={handleEmailAuth} className="space-y-4">
                  <div>
                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 ml-1">Email</label>
                    <input 
                      type="email"
                      required
                      value={authEmail}
                      onChange={(e) => setAuthEmail(e.target.value)}
                      placeholder="email@example.com"
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 ml-1">Mật khẩu</label>
                    <div className="relative">
                      <input 
                        type={showAuthPassword ? "text" : "password"}
                        required
                        minLength={6}
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full pl-4 pr-10 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setShowAuthPassword(!showAuthPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-indigo-600 transition-colors"
                      >
                        {showAuthPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  {authError && (
                    <div className="flex items-center gap-2 p-3 bg-rose-50 text-rose-500 rounded-xl text-xs font-bold animate-shake">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>{authError}</span>
                    </div>
                  )}

                  <button 
                    type="submit"
                    disabled={isLoggingIn}
                    className="w-full bg-indigo-600 text-white py-3.5 rounded-xl font-bold text-sm hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 active:scale-[0.98] disabled:opacity-70 flex items-center justify-center gap-2"
                  >
                    {isLoggingIn ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      'Đăng nhập'
                    )}
                  </button>
                </form>

                <p className="mt-8 text-center text-xs text-slate-500">
                  Chưa có tài khoản? Vui lòng liên hệ quản trị viên.
                </p>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Delete Key Confirmation Modal */}
      <AnimatePresence>
        {keyToDelete && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setKeyToDelete(null)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white w-full max-w-sm rounded-3xl shadow-2xl overflow-hidden p-8 text-center"
            >
              <div className="bg-rose-100 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-rose-100">
                <Trash2 className="text-rose-600 w-8 h-8" />
              </div>
              <h3 className="text-xl font-display font-bold text-slate-800 mb-2">Xác nhận xóa Key?</h3>
              <p className="text-slate-500 text-sm mb-4">
                Bạn có chắc chắn muốn xóa key <span className="font-bold text-slate-700">"{keyToDelete.name}"</span>? 
                Hành động này không thể hoàn tác.
              </p>

              <div className="bg-amber-50 border border-amber-100 rounded-2xl p-4 mb-8 text-left">
                <div className="flex items-center gap-2 mb-2">
                  <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
                  <span className="text-[10px] font-bold text-amber-600 uppercase tracking-widest">Thông tin hạn mức (Free Tier)</span>
                </div>
                <ul className="space-y-1.5">
                  <li className="text-[11px] text-amber-700 leading-relaxed flex justify-between">
                    <span>• Gemini 1.5 Flash:</span>
                    <span className="font-bold">1,500 yêu cầu/ngày</span>
                  </li>
                  <li className="text-[11px] text-amber-700 leading-relaxed flex justify-between">
                    <span>• Gemini 1.5 Pro:</span>
                    <span className="font-bold">50 yêu cầu/ngày</span>
                  </li>
                </ul>
                <p className="mt-2 pt-2 border-t border-amber-200 text-[10px] text-amber-600 italic leading-tight">
                  * Google hiện không cung cấp API để kiểm tra số lượng yêu cầu còn lại chính xác trong ngày.
                </p>
              </div>
              
              <div className="flex gap-3">
                <button 
                  onClick={() => setKeyToDelete(null)}
                  className="flex-1 px-6 py-3 rounded-xl text-sm font-bold text-slate-500 hover:bg-slate-100 transition-colors"
                >
                  Hủy
                </button>
                <button 
                  onClick={() => {
                    handleDeleteKey(keyToDelete.id);
                    setKeyToDelete(null);
                  }}
                  className="flex-1 px-6 py-3 rounded-xl text-sm font-bold bg-rose-500 text-white hover:bg-rose-600 transition-colors shadow-lg shadow-rose-100"
                >
                  Xác nhận xóa
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Mobile View Toggle & Navigation Floating Bar */}
      {pdfDoc && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] md:hidden flex flex-col items-center gap-3 w-[95%] max-w-[420px]">
          {/* Main Action Bar */}
          <div className="w-full flex items-center bg-white/95 backdrop-blur-xl rounded-full shadow-[0_20px_50px_rgba(0,0,0,0.3)] border border-slate-200 p-1 gap-0.5 ring-1 ring-slate-900/5 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* View Toggle */}
            <div className="flex bg-slate-100/80 rounded-full p-0.5 gap-0.5 shrink-0 ml-1">
              <button 
                onClick={() => setMobileViewMode('pdf')}
                className={cn(
                  "flex items-center gap-0.5 px-1.5 py-1 rounded-full text-[7px] font-black uppercase tracking-tighter transition-all duration-300",
                  mobileViewMode === 'pdf' 
                    ? "bg-white text-indigo-600 shadow-sm" 
                    : "text-slate-500"
                )}
              >
                <FileText className="w-2.5 h-2.5" />
                PDF
              </button>
              <button 
                onClick={() => setMobileViewMode('split')}
                className={cn(
                  "flex items-center gap-0.5 px-1.5 py-1 rounded-full text-[7px] font-black uppercase tracking-tighter transition-all duration-300",
                  mobileViewMode === 'split' 
                    ? "bg-white text-indigo-600 shadow-sm" 
                    : "text-slate-500"
                )}
              >
                <Layout className="w-2.5 h-2.5" />
                Đôi
              </button>
              <button 
                onClick={() => setMobileViewMode('translation')}
                className={cn(
                  "flex items-center gap-0.5 px-1.5 py-1 rounded-full text-[7px] font-black uppercase tracking-tighter transition-all duration-300",
                  mobileViewMode === 'translation' 
                    ? "bg-white text-indigo-600 shadow-sm" 
                    : "text-slate-500"
                )}
              >
                <Languages className="w-2.5 h-2.5" />
                Dịch
              </button>
            </div>
            
            <div className="w-px h-6 bg-slate-200 mx-0.5 shrink-0" />
            
            {/* Navigation */}
            <div className="flex-1 flex items-center justify-center gap-0">
              <button 
                onClick={() => {
                  setCurrentPage(p => Math.max(1, p - 1));
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                disabled={currentPage === 1}
                className="p-1.5 text-slate-600 disabled:opacity-20 active:scale-75 transition-all"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              
              <span className="text-[10px] font-black text-slate-800 min-w-[30px] text-center">{currentPage}/{numPages}</span>
              
              <button 
                onClick={() => {
                  setCurrentPage(p => Math.min(numPages, p + 1));
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                disabled={currentPage === numPages}
                className="p-1.5 text-slate-600 disabled:opacity-20 active:scale-75 transition-all"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="w-px h-6 bg-slate-200 mx-0.5 shrink-0" />

            {/* Right Actions */}
            <div className="flex items-center gap-0.5 pr-1 shrink-0">
              <button 
                onClick={() => translateCurrentPage(currentPage, true)}
                disabled={isTranslating || isRendering}
                className={cn(
                  "p-2 rounded-full transition-all",
                  (isTranslating || isRendering)
                    ? "text-slate-300"
                    : "text-indigo-600 active:bg-indigo-50"
                )}
              >
                <RefreshCcw className={cn("w-4 h-4", (isTranslating || isRendering) && "animate-spin")} />
              </button>

              <button 
                onClick={() => setAutoTranslate(!autoTranslate)}
                className={cn(
                  "p-2 rounded-full transition-all relative",
                  autoTranslate ? "text-emerald-600" : "text-slate-400"
                )}
              >
                <div className={cn(
                  "w-1 h-1 rounded-full absolute top-1.5 right-1.5",
                  autoTranslate ? "bg-emerald-500 animate-pulse" : "hidden"
                )} />
                <Languages className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Folder Selection Modal for Late Upload */}
      <AnimatePresence>
        {showFolderSelectModal && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowFolderSelectModal(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-3">
                  <div className="bg-amber-100 p-2 rounded-xl">
                    <Folder className="text-amber-600 w-5 h-5" />
                  </div>
                  <h3 className="text-xl font-display font-bold text-slate-800">Chọn thư mục tải lên</h3>
                </div>
                <button 
                  onClick={() => setShowFolderSelectModal(false)}
                  className="p-2 hover:bg-slate-100 rounded-full transition-colors"
                >
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-4 space-y-2 no-scrollbar">
                <p className="text-xs font-medium text-slate-400 px-2 mb-2 uppercase tracking-wider">Thư mục hiện có</p>
                
                <button 
                  onClick={() => startUpload(file!, null)}
                  className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 rounded-2xl transition-all text-left group border border-transparent hover:border-slate-100"
                >
                  <div className="bg-slate-100 p-2 rounded-xl group-hover:bg-indigo-100 transition-colors">
                    <Home className="w-5 h-5 text-slate-500 group-hover:text-indigo-600" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-700">Root (Thư mục gốc)</p>
                    <p className="text-[10px] text-slate-400">Tải trực tiếp lên thư mục chính</p>
                  </div>
                </button>

                {allFolders.map(folder => (
                  <button 
                    key={folder.id}
                    onClick={() => startUpload(file!, folder.id)}
                    className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 rounded-2xl transition-all text-left group border border-transparent hover:border-slate-100"
                  >
                    <div className="bg-amber-50 p-2 rounded-xl group-hover:bg-amber-100 transition-colors">
                      <Folder className="w-5 h-5 text-amber-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-slate-700">{folder.name}</p>
                      <p className="text-[10px] text-slate-400">{getFolderPath(folder.id)}</p>
                    </div>
                  </button>
                ))}

                {allFolders.length === 0 && (
                  <div className="py-8 text-center">
                    <p className="text-sm text-slate-400">Chưa có thư mục nào. Bạn có thể tải lên Root.</p>
                  </div>
                )}
              </div>

              <div className="p-4 border-t border-slate-100 bg-slate-50 flex justify-end">
                <button 
                  onClick={() => setShowFolderSelectModal(false)}
                  className="px-6 py-2 text-slate-500 text-sm font-bold hover:bg-slate-100 rounded-xl transition-colors"
                >
                  Hủy bỏ
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSettings(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-3">
                  <div className="bg-indigo-100 p-2 rounded-xl">
                    <Settings className="text-indigo-600 w-5 h-5" />
                  </div>
                  <h3 className="text-xl font-display font-bold text-slate-800">Cấu hình hệ thống</h3>
                </div>
                <button 
                  onClick={() => setShowSettings(false)}
                  className="p-2 hover:bg-slate-100 rounded-full transition-colors"
                >
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-6 space-y-6 no-scrollbar">
                {/* User Profile Section */}
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center overflow-hidden">
                      {user ? (
                        <img 
                          src={user.photoURL || `https://ui-avatars.com/api/?name=${user.displayName || 'User'}&background=6366f1&color=fff`} 
                          alt="Avatar" 
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <UserIcon className="w-5 h-5 text-indigo-600" />
                      )}
                    </div>
                    <div>
                      <p className="text-xs font-bold text-slate-800">{user ? (user.displayName || user.email) : 'Khách'}</p>
                      <p className="text-[10px] text-slate-500">{user ? (userRole === 'admin' ? 'Quản trị viên' : 'Người dùng') : 'Đăng nhập để lưu Key'}</p>
                    </div>
                  </div>
                  {user ? (
                    <div className="flex gap-2">
                      {userRole === 'admin' && (
                        <button 
                          onClick={() => {
                            setShowSettings(false);
                            setShowAdminPanel(true);
                            fetchAllUsers();
                          }}
                          className="px-3 py-1.5 bg-amber-100 text-amber-700 rounded-lg text-[10px] font-bold hover:bg-amber-200 transition-all"
                        >
                          Quản trị
                        </button>
                      )}
                      <button 
                        onClick={handleLogout}
                        className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-all"
                        title="Đăng xuất"
                      >
                        <LogOut className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <button 
                      onClick={() => {
                        setShowSettings(false);
                        setShowAuthModal(true);
                      }}
                      className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 transition-all shadow-md shadow-indigo-100"
                    >
                      Đăng nhập
                    </button>
                  )}
                </div>

                {/* Change Password Section */}
                {user && (
                  <div className="pt-4 border-t border-slate-100">
                    <button 
                      onClick={() => setShowChangePassword(!showChangePassword)}
                      className="flex items-center justify-between w-full text-left"
                    >
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 text-indigo-500" />
                        <label className="text-xs font-bold text-slate-700 uppercase tracking-widest">
                          Đổi mật khẩu
                        </label>
                      </div>
                      <ChevronRight className={cn("w-4 h-4 text-slate-400 transition-transform", showChangePassword && "rotate-90")} />
                    </button>
                    
                    <AnimatePresence>
                      {showChangePassword && (
                        <motion.div 
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="pt-4 space-y-3">
                            <div className="relative">
                              <input 
                                type={showNewPassword ? "text" : "password"}
                                placeholder="Mật khẩu mới (tối thiểu 6 ký tự)"
                                value={newPasswordValue}
                                onChange={(e) => setNewPasswordValue(e.target.value)}
                                className="w-full pl-3 pr-10 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500 outline-none"
                              />
                              <button
                                type="button"
                                onClick={() => setShowNewPassword(!showNewPassword)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-indigo-600 transition-colors"
                              >
                                {showNewPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                              </button>
                            </div>
                            <button 
                              onClick={async () => {
                                if (newPasswordValue.length < 6) {
                                  showToast("Mật khẩu phải có ít nhất 6 ký tự", 'error');
                                  return;
                                }
                                try {
                                  const success = await changeOwnPassword(newPasswordValue);
                                  if (success) {
                                    showToast("Đã đổi mật khẩu thành công", 'success');
                                    setNewPasswordValue('');
                                    setShowChangePassword(false);
                                  }
                                } catch (e: any) {
                                  showToast(e.message, 'error');
                                }
                              }}
                              className="w-full py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 transition-all"
                            >
                              Xác nhận đổi mật khẩu
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}

                <div className="space-y-4 pt-4 border-t border-slate-100">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Zap className="w-4 h-4 text-emerald-500" />
                      <label className="text-xs font-bold text-slate-700 uppercase tracking-widest">
                        Tự động dịch (Auto-Translate)
                      </label>
                    </div>
                    <button 
                      onClick={() => setAutoTranslate(!autoTranslate)}
                      className={cn(
                        "relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none",
                        autoTranslate ? "bg-emerald-500" : "bg-slate-200"
                      )}
                    >
                      <span className={cn(
                        "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                        autoTranslate ? "translate-x-6" : "translate-x-1"
                      )} />
                    </button>
                  </div>

                  {autoTranslate && (
                    <div className="space-y-3 animate-in fade-in slide-in-from-top-2">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                          Số trang dịch trước (Buffer)
                        </label>
                        <span className="text-xs font-black text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-md">
                          {autoTranslateLookAhead} trang
                        </span>
                      </div>
                      <input 
                        type="range"
                        min="0"
                        max="5"
                        step="1"
                        value={autoTranslateLookAhead}
                        onChange={(e) => setAutoTranslateLookAhead(parseInt(e.target.value))}
                        className="w-full h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                      />
                      <p className="text-[9px] text-slate-400 italic">
                        * Tự động dịch trước các trang tiếp theo để trải nghiệm đọc mượt mà hơn.
                      </p>
                    </div>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest">
                      API Key cho Gemini 3 Flash
                    </label>
                    {currentKeyRef.current?.split(',').length! > 1 && (
                      <div className="flex items-center gap-1.5 px-2 py-0.5 bg-emerald-50 text-emerald-600 rounded-full border border-emerald-100 animate-pulse">
                        <RefreshCcw className="w-2.5 h-2.5" />
                        <span className="text-[8px] font-black uppercase tracking-tighter">Luân phiên: BẬT ({currentKeyRef.current?.split(',').length})</span>
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 mt-3">
                    <div className="flex-1 relative">
                      <input 
                        type={showApiKeys ? "text" : "password"}
                        value={tempKeys['gemini-flash']}
                        onChange={(e) => {
                          setTempKeys(prev => ({ ...prev, ['gemini-flash']: e.target.value }));
                          setTestStatus({ type: null, message: '' });
                        }}
                        placeholder="Key 1, Key 2, Key 3..."
                        className="w-full pl-4 pr-10 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all font-mono text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKeys(!showApiKeys)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-indigo-600 transition-colors"
                      >
                        {showApiKeys ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <button 
                      onClick={async () => {
                        if (!tempKeys['gemini-flash']) {
                          setTestStatus({ type: 'error', message: "Vui lòng nhập ít nhất một API Key để kiểm tra." });
                          return;
                        }
                        setTestStatus({ type: 'loading', message: "Đang kiểm tra..." });
                        // Use first key if multiple provided for validation
                        const firstKey = tempKeys['gemini-flash'].split(/[,\n]/)[0].trim();
                        const testService = new GeminiService(firstKey, "gemini-3.1-flash-lite-preview");
                        try {
                          await testService.lookupMedicalTerm("test");
                          setTestStatus({ type: 'success', message: "Kết nối thành công! API Key hoạt động tốt." });
                        } catch (err: any) {
                          setTestStatus({ type: 'error', message: "Lỗi kết nối: " + err.message });
                        }
                      }}
                      disabled={testStatus.type === 'loading'}
                      className="px-4 bg-indigo-50 text-indigo-600 rounded-xl hover:bg-indigo-100 transition-all flex items-center justify-center disabled:opacity-50"
                      title="Kiểm tra kết nối"
                    >
                      {testStatus.type === 'loading' ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4" />
                      )}
                    </button>
                  </div>

                  {testStatus.type && (
                    <div className={cn(
                      "mt-2 p-3 rounded-xl text-[10px] font-bold flex items-center gap-2 animate-in fade-in slide-in-from-top-1",
                      testStatus.type === 'success' ? "bg-emerald-50 text-emerald-600 border border-emerald-100" : 
                      testStatus.type === 'error' ? "bg-rose-50 text-rose-600 border border-rose-100" :
                      "bg-indigo-50 text-indigo-600 border border-indigo-100"
                    )}>
                      {testStatus.type === 'success' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                      {testStatus.message}
                    </div>
                  )}
                  
                  <div className="mt-2 p-3 bg-indigo-50 rounded-lg border border-indigo-100">
                    <p className="text-[10px] text-indigo-700 leading-relaxed">
                      <span className="font-bold">Mẹo:</span> Bạn có thể nhập <span className="underline italic">nhiều Key cách nhau bằng dấu phẩy</span> để hệ thống tự động luân phiên (rotation) khi hết hạn mức.
                    </p>
                  </div>

                  {(window as any).aistudio?.openSelectKey && (
                    <button 
                      onClick={async () => {
                        if (translationService.current instanceof GeminiService) {
                          await (translationService.current as any).openKeySelection();
                          setShowSettings(false);
                        }
                      }}
                      className="mt-3 w-full px-4 py-2.5 bg-indigo-100 text-indigo-700 rounded-xl text-[10px] font-bold hover:bg-indigo-200 transition-all flex items-center justify-center gap-2"
                    >
                      <Settings className="w-3.5 h-3.5" />
                      Sử dụng API Key từ AI Studio
                    </button>
                  )}
                </div>
                
                {/* Key Vault Section */}
                <div className="pt-4 border-t border-slate-100">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <Key className="w-4 h-4 text-indigo-500" />
                      <label className="text-xs font-bold text-slate-700 uppercase tracking-widest">
                        Kho lưu trữ Key (Vault)
                      </label>
                    </div>
                    {user && (
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={() => performKeyCheck(false)}
                          disabled={isCheckingKeys}
                          className="p-1.5 hover:bg-indigo-50 text-indigo-600 rounded-lg transition-all active:scale-95 disabled:opacity-50"
                          title="Kiểm tra tất cả Key"
                        >
                          {isCheckingKeys ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCcw className="w-3.5 h-3.5" />}
                        </button>
                        <button 
                          onClick={() => setIsAddingKey(!isAddingKey)}
                          className="text-[10px] font-black text-indigo-600 hover:text-indigo-700 uppercase tracking-tighter flex items-center gap-1 bg-indigo-50 px-2 py-1 rounded-md"
                        >
                          <Plus className="w-3 h-3" /> Thêm Key mới
                        </button>
                      </div>
                    )}
                  </div>

                  {!user ? (
                    <div className="bg-slate-50 rounded-2xl p-6 text-center border border-dashed border-slate-200">
                      <ShieldCheck className="w-8 h-8 text-slate-300 mx-auto mb-3" />
                      <p className="text-xs font-bold text-slate-500 mb-4">Đăng nhập để lưu trữ nhiều API Key và tự động chuyển đổi khi hết hạn mức.</p>
                      <button 
                        onClick={() => setShowAuthModal(true)}
                        className="bg-indigo-600 text-white px-6 py-2 rounded-full text-xs font-bold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100"
                      >
                        Đăng nhập ngay
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {isAddingKey && (
                        <motion.div 
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="bg-indigo-50/50 rounded-2xl p-4 border border-indigo-100 mb-4"
                        >
                          <div className="grid grid-cols-1 gap-3 mb-3">
                            <input 
                              type="text"
                              placeholder="Tên gợi nhớ (VD: Key 1)"
                              value={newKey.name}
                              onChange={(e) => setNewKey(prev => ({ ...prev, name: e.target.value }))}
                              className="px-3 py-2 bg-white border border-indigo-100 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500 outline-none"
                            />
                          </div>
                          <div className="relative">
                            <input 
                              type={showApiKeys ? "text" : "password"}
                              placeholder="Dán API Key vào đây..."
                              value={newKey.value}
                              onChange={(e) => setNewKey(prev => ({ ...prev, value: e.target.value }))}
                              className="w-full pl-3 pr-10 py-2 bg-white border border-indigo-100 rounded-xl text-xs mb-3 focus:ring-2 focus:ring-indigo-500 outline-none font-mono"
                            />
                            <button
                              type="button"
                              onClick={() => setShowApiKeys(!showApiKeys)}
                              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-indigo-600 transition-colors mb-3"
                            >
                              {showApiKeys ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                          <div className="flex justify-end gap-2">
                            <button 
                              onClick={() => setIsAddingKey(false)}
                              className="px-3 py-1.5 text-[10px] font-bold text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
                            >
                              Hủy
                            </button>
                            <button 
                              onClick={handleAddKey}
                              className="px-4 py-1.5 bg-indigo-600 text-white rounded-lg text-[10px] font-bold hover:bg-indigo-700 transition-all shadow-md shadow-indigo-100"
                            >
                              Lưu vào Vault
                            </button>
                          </div>
                        </motion.div>
                      )}

                      <div className="max-h-[200px] overflow-y-auto pr-2 space-y-2 no-scrollbar">
                        {userKeys.length === 0 ? (
                          <p className="text-[10px] text-slate-400 text-center py-4 italic">Chưa có Key nào trong kho lưu trữ.</p>
                        ) : (
                          userKeys.map((key) => (
                            <div 
                              key={key.id}
                              className={cn(
                                "flex items-center justify-between p-3 rounded-xl border transition-all group",
                                selectedKeyId === key.id 
                                  ? "bg-indigo-50 border-indigo-200 ring-1 ring-indigo-200" 
                                  : "bg-white border-slate-100 hover:border-slate-200"
                              )}
                            >
                              <div 
                                className="flex-1 cursor-pointer"
                                onClick={() => setSelectedKeyId(key.id)}
                              >
                                <div className="flex items-center gap-2 mb-0.5">
                                  <span className="text-xs font-bold text-slate-700">{key.name}</span>
                                  {key.status && (
                                    <span className={cn(
                                      "text-[8px] px-1.5 py-0.5 rounded-full font-black uppercase tracking-tighter",
                                      key.status === 'active' ? "bg-emerald-100 text-emerald-600" : "bg-rose-100 text-rose-600"
                                    )}>
                                      {key.status === 'active' ? 'Hoạt động' : 'Lỗi'}
                                    </span>
                                  )}
                                </div>
                                <p className="text-[10px] text-slate-400 font-mono truncate max-w-[200px]">
                                  {key.value.substring(0, 8)}••••••••{key.value.substring(key.value.length - 4)}
                                </p>
                                {key.lastUsed && (
                                  <p className="text-[8px] text-slate-300 italic mt-0.5">
                                    Dùng lần cuối: {new Date(key.lastUsed.toDate()).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}
                                  </p>
                                )}
                              </div>
                              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button 
                                  onClick={() => setKeyToDelete(key)}
                                  className="p-1.5 hover:bg-rose-50 text-rose-400 hover:text-rose-500 rounded-lg transition-colors"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                                {selectedKeyId === key.id && (
                                  <div className="bg-emerald-500 p-1 rounded-full">
                                    <CheckCircle2 className="w-3 h-3 text-white" />
                                  </div>
                                )}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              
              <div className="p-6 border-t border-slate-100 bg-slate-50 flex gap-3 shrink-0">
                <button 
                  onClick={() => setShowSettings(false)}
                  className="flex-1 px-6 py-3 rounded-xl text-sm font-bold text-slate-500 hover:bg-slate-100 transition-colors"
                >
                  Hủy
                </button>
                <button 
                  onClick={() => saveSettings(tempKeys)}
                  className="flex-1 px-6 py-3 rounded-xl text-sm font-bold bg-indigo-600 text-white hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200"
                >
                  Lưu cấu hình
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Download Modal */}
      <AnimatePresence>
        {showDownloadModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowDownloadModal(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-3">
                  <div className="bg-indigo-100 p-2 rounded-xl">
                    <Download className="text-indigo-600 w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-xl font-display font-bold text-slate-800">Tải xuống bản dịch</h3>
                    <p className="text-[10px] text-slate-400 font-medium">Chọn các trang bạn muốn xuất ra file Word (.docx)</p>
                  </div>
                </div>
                <button 
                  onClick={() => setShowDownloadModal(false)}
                  className="p-2 hover:bg-slate-100 rounded-full transition-colors"
                >
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 no-scrollbar">
                <div className="mb-4 flex items-center justify-between bg-slate-50 p-3 rounded-2xl border border-slate-100">
                  <div className="flex items-center gap-4">
                    <button 
                      onClick={() => {
                        const allTranslated = Object.keys(translations)
                          .filter(p => translations[Number(p)]?.status === 'success')
                          .map(Number);
                        setSelectedPagesToDownload(allTranslated);
                      }}
                      className="text-[10px] font-black text-indigo-600 hover:text-indigo-700 uppercase tracking-widest"
                    >
                      Chọn tất cả đã dịch
                    </button>
                    <button 
                      onClick={() => setSelectedPagesToDownload([])}
                      className="text-[10px] font-black text-slate-400 hover:text-slate-500 uppercase tracking-widest"
                    >
                      Bỏ chọn tất cả
                    </button>
                  </div>
                  <div className="text-[10px] font-bold text-slate-500">
                    Đã chọn: <span className="text-indigo-600">{selectedPagesToDownload.length}</span> trang
                  </div>
                </div>

                <div className="grid grid-cols-5 sm:grid-cols-8 gap-2 p-1">
                  {Array.from({ length: numPages }, (_, i) => i + 1).map(pageNum => {
                    const isTranslated = translations[pageNum]?.status === 'success';
                    const isSelected = selectedPagesToDownload.includes(pageNum);
                    
                    return (
                      <button
                        key={pageNum}
                        disabled={!isTranslated}
                        onClick={() => {
                          if (isSelected) {
                            setSelectedPagesToDownload(prev => prev.filter(p => p !== pageNum));
                          } else {
                            setSelectedPagesToDownload(prev => [...prev, pageNum].sort((a, b) => a - b));
                          }
                        }}
                        className={cn(
                          "aspect-square rounded-xl border flex flex-col items-center justify-center transition-all relative group",
                          isSelected 
                            ? "bg-indigo-600 border-indigo-600 text-white shadow-lg shadow-indigo-100 scale-105 z-10" 
                            : isTranslated
                              ? "bg-white border-indigo-100 text-slate-700 hover:border-indigo-300 hover:bg-indigo-50/30"
                              : "bg-slate-50 border-slate-100 text-slate-300 cursor-not-allowed opacity-60"
                        )}
                      >
                        <span className="text-xs font-black">{pageNum}</span>
                        {isTranslated && !isSelected && (
                          <div className="absolute top-1 right-1 w-1.5 h-1.5 bg-emerald-500 rounded-full" />
                        )}
                        {isSelected && (
                          <CheckCircle2 className="w-3 h-3 absolute -top-1 -right-1 bg-white text-indigo-600 rounded-full" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="p-6 border-t border-slate-100 bg-slate-50 flex gap-3 shrink-0">
                <button 
                  onClick={() => setShowDownloadModal(false)}
                  className="flex-1 px-6 py-3 rounded-xl text-sm font-bold text-slate-500 hover:bg-slate-100 transition-colors"
                >
                  Hủy
                </button>
                <button 
                  disabled={selectedPagesToDownload.length === 0}
                  onClick={() => {
                    handleDownload(selectedPagesToDownload);
                    setShowDownloadModal(false);
                  }}
                  className="flex-1 px-6 py-3 rounded-xl text-sm font-bold bg-indigo-600 text-white hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200 disabled:opacity-50 disabled:shadow-none flex items-center justify-center gap-2"
                >
                  <Download className="w-4 h-4" />
                  Tải file Word ({selectedPagesToDownload.length} trang)
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Diagnostic Modal */}
      <AnimatePresence>
        {isDiagnosticModalOpen && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden border border-slate-100"
            >
              <div className="p-6 border-b border-slate-50 flex items-center justify-between bg-slate-50/50">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-indigo-50 flex items-center justify-center">
                    <Activity className="w-5 h-5 text-indigo-600" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900">Chẩn đoán hệ thống</h3>
                    <p className="text-xs text-slate-500">Kiểm tra trạng thái kết nối Firebase</p>
                  </div>
                </div>
                <button 
                  onClick={() => setIsDiagnosticModalOpen(false)}
                  className="p-2 hover:bg-white rounded-xl transition-colors text-slate-400 hover:text-slate-600 shadow-sm"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              
              <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
                {diagnosticResults && (
                  <>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="p-4 rounded-2xl bg-slate-50 border border-slate-100">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Dự án</p>
                        <p className="text-xs font-mono text-slate-700 break-all">{diagnosticResults.projectId}</p>
                      </div>
                      <div className="p-4 rounded-2xl bg-slate-50 border border-slate-100">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Database ID</p>
                        <p className="text-xs font-mono text-slate-700 break-all">{diagnosticResults.databaseId || '(default)'}</p>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className={cn(
                        "p-4 rounded-2xl border flex items-start gap-3",
                        diagnosticResults.auth.status === 'ok' ? "bg-emerald-50 border-emerald-100" : "bg-rose-50 border-rose-100"
                      )}>
                        {diagnosticResults.auth.status === 'ok' ? (
                          <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                        ) : (
                          <AlertCircle className="w-5 h-5 text-rose-500 shrink-0" />
                        )}
                        <div>
                          <p className={cn("text-xs font-bold", diagnosticResults.auth.status === 'ok' ? "text-emerald-800" : "text-rose-800")}>
                            Firebase Authentication API
                          </p>
                          <p className={cn("text-[10px] mt-0.5", diagnosticResults.auth.status === 'ok' ? "text-emerald-600" : "text-rose-600")}>
                            {diagnosticResults.auth.status === 'ok' ? "Hoạt động bình thường" : `Lỗi: ${diagnosticResults.auth.message}`}
                          </p>
                          {diagnosticResults.auth.status !== 'ok' && (
                            <div className="mt-2 space-y-1">
                              {diagnosticResults.auth.advice && (
                                <p className="text-[9px] text-rose-700 font-medium">{diagnosticResults.auth.advice}</p>
                              )}
                              <a 
                                href={diagnosticResults.auth.link || `https://console.developers.google.com/apis/api/identitytoolkit.googleapis.com/overview?project=${diagnosticResults.projectId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-700 hover:underline"
                              >
                                {diagnosticResults.auth.link ? "Mở Console ngay" : "Kích hoạt Identity Toolkit"} <ExternalLink className="w-3 h-3" />
                              </a>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className={cn(
                        "p-4 rounded-2xl border flex items-start gap-3",
                        diagnosticResults.firestore.status === 'ok' ? "bg-emerald-50 border-emerald-100" : "bg-rose-50 border-rose-100"
                      )}>
                        {diagnosticResults.firestore.status === 'ok' ? (
                          <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                        ) : (
                          <AlertCircle className="w-5 h-5 text-rose-500 shrink-0" />
                        )}
                        <div>
                          <p className={cn("text-xs font-bold", diagnosticResults.firestore.status === 'ok' ? "text-emerald-800" : "text-rose-800")}>
                            Cloud Firestore API
                          </p>
                          <p className={cn("text-[10px] mt-0.5", diagnosticResults.firestore.status === 'ok' ? "text-emerald-600" : "text-rose-600")}>
                            {diagnosticResults.firestore.status === 'ok' ? "Hoạt động bình thường" : `Lỗi: ${diagnosticResults.firestore.message}`}
                          </p>
                          {diagnosticResults.firestore.status !== 'ok' && (
                            <div className="mt-2 space-y-2">
                              {diagnosticResults.firestore.advice && (
                                <p className="text-[9px] text-rose-700 font-medium">{diagnosticResults.firestore.advice}</p>
                              )}
                              <a 
                                href={diagnosticResults.firestore.link || `https://console.cloud.google.com/apis/library/firestore.googleapis.com?project=${diagnosticResults.projectId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-700 hover:underline"
                              >
                                {diagnosticResults.firestore.link ? "Mở Console ngay" : "Kích hoạt Firestore API"} <ExternalLink className="w-3 h-3" />
                              </a>
                              {!diagnosticResults.firestore.advice && (
                                <p className="text-[9px] text-rose-500 italic">
                                  Gợi ý: Nếu API đã bật, hãy đảm bảo bạn đã "Tạo Database" trong Firebase Console.
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      {diagnosticResults.firestore.fallbackStatus === 'ok_with_default_db' && (
                        <div className="p-4 rounded-2xl bg-amber-50 border border-amber-100 flex items-start gap-3">
                          <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />
                          <div>
                            <p className="text-xs font-bold text-amber-800">Lưu ý: Đang sử dụng Database mặc định</p>
                            <p className="text-[10px] text-amber-600 mt-0.5">
                              Database định danh thất bại, nhưng Database mặc định (default) hoạt động. Ứng dụng sẽ tự động chuyển vùng dữ liệu.
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
              
              <div className="p-6 bg-slate-50 border-t border-slate-100 flex justify-end">
                <button 
                  onClick={() => setIsDiagnosticModalOpen(false)}
                  className="px-6 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-2xl text-sm font-bold hover:bg-slate-50 transition-all shadow-sm"
                >
                  Đóng
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Admin Panel Modal */}
      <AnimatePresence>
        {showAdminPanel && (
          <div className="fixed inset-0 z-[150] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowAdminPanel(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white w-full max-w-4xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-white sticky top-0 z-10">
                <div className="flex items-center gap-3">
                  <div className="bg-amber-100 p-2 rounded-xl">
                    <ShieldCheck className="text-amber-600 w-5 h-5" />
                  </div>
                  <h3 className="text-xl font-display font-bold text-slate-800">Quản trị hệ thống</h3>
                </div>
                <button 
                  onClick={() => setShowAdminPanel(false)}
                  className="p-2 hover:bg-slate-100 rounded-full transition-colors"
                >
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-8 no-scrollbar">
                {/* Stats Section */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="bg-indigo-50 p-5 rounded-3xl border border-indigo-100 shadow-sm">
                    <div className="flex items-center gap-3 mb-2">
                      <div className="bg-indigo-100 p-2 rounded-xl">
                        <Users className="w-4 h-4 text-indigo-600" />
                      </div>
                      <span className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Tổng người dùng</span>
                    </div>
                    <p className="text-3xl font-display font-black text-indigo-900">{allUsers.length}</p>
                  </div>
                  <div className="bg-amber-50 p-5 rounded-3xl border border-amber-100 shadow-sm">
                    <div className="flex items-center gap-3 mb-2">
                      <div className="bg-amber-100 p-2 rounded-xl">
                        <ShieldCheck className="w-4 h-4 text-amber-600" />
                      </div>
                      <span className="text-[10px] font-black text-amber-400 uppercase tracking-widest">Quản trị viên</span>
                    </div>
                    <p className="text-3xl font-display font-black text-amber-900">{allUsers.filter(u => u.role === 'admin').length}</p>
                  </div>
                  <div className="bg-rose-50 p-5 rounded-3xl border border-rose-100 shadow-sm">
                    <div className="flex items-center gap-3 mb-2">
                        <div className="bg-rose-100 p-2 rounded-xl">
                          <ShieldAlert className="w-4 h-4 text-rose-600" />
                        </div>
                        <span className="text-[10px] font-black text-rose-400 uppercase tracking-widest">Tài khoản bị chặn</span>
                      </div>
                      <p className="text-3xl font-display font-black text-rose-900">{allUsers.filter(u => u.isBlocked).length}</p>
                    </div>
                  </div>

                  {/* Create User Section */}
                  <section>
                    <div className="flex items-center gap-2 mb-4">
                      <div className="w-1.5 h-4 bg-indigo-500 rounded-full" />
                      <h4 className="text-sm font-bold text-slate-800">Thêm người dùng mới</h4>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3 bg-slate-50 p-5 rounded-2xl border border-slate-100">
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-bold text-slate-400 uppercase ml-1">Tên hiển thị</label>
                        <input 
                          type="text"
                          placeholder="VD: Nguyễn Văn A"
                          value={adminNewUserDisplayName}
                          onChange={(e) => setAdminNewUserDisplayName(e.target.value)}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-bold text-slate-400 uppercase ml-1">Email</label>
                        <input 
                          type="email"
                          placeholder="email@example.com"
                          value={adminNewUserEmail}
                          onChange={(e) => setAdminNewUserEmail(e.target.value)}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-bold text-slate-400 uppercase ml-1">Mật khẩu</label>
                        <div className="relative">
                          <input 
                            type={showAdminNewUserPassword ? "text" : "password"}
                            placeholder="••••••••"
                            value={adminNewUserPassword}
                            onChange={(e) => setAdminNewUserPassword(e.target.value)}
                            className="w-full pl-3 pr-10 py-2 bg-white border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                          />
                          <button
                            type="button"
                            onClick={() => setShowAdminNewUserPassword(!showAdminNewUserPassword)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-indigo-600 transition-colors"
                          >
                            {showAdminNewUserPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-bold text-slate-400 uppercase ml-1">Vai trò</label>
                        <select 
                          value={adminNewUserRole}
                          onChange={(e) => setAdminNewUserRole(e.target.value as 'user' | 'admin')}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500 outline-none transition-all appearance-none cursor-pointer"
                        >
                          <option value="user">Người dùng</option>
                          <option value="admin">Quản trị viên</option>
                        </select>
                      </div>
                      <div className="flex items-end">
                        <button 
                          onClick={async () => {
                            if (!adminNewUserEmail || !adminNewUserPassword) {
                              showToast("Vui lòng nhập email và mật khẩu", 'error');
                              return;
                            }
                            setIsCreatingUser(true);
                            try {
                              await createNewUser({
                                email: adminNewUserEmail,
                                password: adminNewUserPassword,
                                displayName: adminNewUserDisplayName,
                                role: adminNewUserRole
                              });
                              showToast("Đã thêm người dùng thành công", 'success');
                              setAdminNewUserEmail('');
                              setAdminNewUserPassword('');
                              setAdminNewUserDisplayName('');
                            } catch (e: any) {
                              if (e.message.includes("Identity Toolkit API")) {
                                showToast("Lỗi: Identity Toolkit API chưa được kích hoạt. Vui lòng kiểm tra cấu hình dự án.", 'error');
                              } else {
                                showToast(e.message, 'error');
                              }
                            } finally {
                              setIsCreatingUser(false);
                            }
                          }}
                          disabled={isCreatingUser}
                          className="w-full py-2.5 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 transition-all flex items-center justify-center gap-2 disabled:opacity-50 shadow-lg shadow-indigo-200"
                        >
                          {isCreatingUser ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                          Thêm ngay
                        </button>
                      </div>
                    </div>
                  </section>

                  {/* User List Section */}
                  <section>
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                        <Users className="w-3.5 h-3.5" />
                        Danh sách người dùng ({allUsers.length})
                      </h4>
                      <div className="flex items-center gap-3">
                        <div className="relative">
                          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" />
                          <input 
                            type="text"
                            placeholder="Tìm kiếm email/tên..."
                            value={adminUserSearch}
                            onChange={(e) => setAdminUserSearch(e.target.value)}
                            className="pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-[10px] focus:ring-2 focus:ring-indigo-500 outline-none w-40 transition-all"
                          />
                        </div>
                        <select 
                          value={adminRoleFilter}
                          onChange={(e) => setAdminRoleFilter(e.target.value as any)}
                          className="px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-[10px] focus:ring-2 focus:ring-indigo-500 outline-none transition-all appearance-none cursor-pointer pr-6"
                        >
                          <option value="all">Tất cả</option>
                          <option value="user">Thành viên</option>
                          <option value="admin">Quản trị viên</option>
                          <option value="blocked">Đã chặn</option>
                        </select>
                        {(activeProjectId || activeDatabaseId) && (
                          <div className="hidden md:flex flex-col items-end mr-2 border-r border-slate-100 pr-2">
                            <div className="text-[7px] font-mono text-slate-400 uppercase tracking-tighter">Project: {activeProjectId}</div>
                            <div className="text-[7px] font-mono text-slate-400 uppercase tracking-tighter">DB: {activeDatabaseId}</div>
                          </div>
                        )}
                        <button 
                          onClick={runDiagnostics}
                          disabled={isRunningDiagnostics}
                          className="p-1.5 hover:bg-slate-100 text-slate-500 rounded-lg transition-colors flex items-center gap-1.5"
                          title="Chẩn đoán hệ thống"
                        >
                          <Activity className={cn("w-3.5 h-3.5", isRunningDiagnostics && "animate-pulse")} />
                          <span className="text-[10px] font-medium">Chẩn đoán</span>
                        </button>
                        <button 
                          onClick={fetchAllUsers}
                          className="p-1.5 hover:bg-slate-100 text-slate-500 rounded-lg transition-colors"
                          title="Làm mới"
                        >
                          <RefreshCcw className={cn("w-3.5 h-3.5", isFetchingUsers && "animate-spin")} />
                        </button>
                      </div>
                    </div>

                    <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden shadow-sm">
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-slate-50/50 text-slate-400 font-bold uppercase tracking-widest border-b border-slate-100">
                            <tr>
                              <th className="px-6 py-4">Thông tin người dùng</th>
                              <th className="px-6 py-4">Vai trò</th>
                              <th className="px-6 py-4">Ngày tham gia</th>
                              <th className="px-6 py-4 text-right">Hành động</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-50">
                            {allUsers
                              .filter(u => {
                                const searchMatch = (u.email || '').toLowerCase().includes(adminUserSearch.toLowerCase()) || 
                                                   (u.displayName || '').toLowerCase().includes(adminUserSearch.toLowerCase());
                                let roleMatch = true;
                                if (adminRoleFilter === 'admin') roleMatch = u.role === 'admin';
                                else if (adminRoleFilter === 'user') roleMatch = u.role === 'user';
                                else if (adminRoleFilter === 'blocked') roleMatch = u.isBlocked === true;
                                return searchMatch && roleMatch;
                              })
                              .length === 0 ? (
                              <tr>
                                <td colSpan={4} className="px-6 py-12 text-center text-slate-400 italic">
                                  Không tìm thấy người dùng phù hợp
                                </td>
                              </tr>
                            ) : (
                              allUsers
                                .filter(u => {
                                  const searchMatch = (u.email || '').toLowerCase().includes(adminUserSearch.toLowerCase()) || 
                                                     (u.displayName || '').toLowerCase().includes(adminUserSearch.toLowerCase());
                                  let roleMatch = true;
                                  if (adminRoleFilter === 'admin') roleMatch = u.role === 'admin';
                                  else if (adminRoleFilter === 'user') roleMatch = u.role === 'user';
                                  else if (adminRoleFilter === 'blocked') roleMatch = u.isBlocked === true;
                                  return searchMatch && roleMatch;
                                })
                                .map((u) => (
                                <tr key={u.uid} className={cn(
                                  "hover:bg-slate-50/30 transition-colors group",
                                  u.isBlocked && "bg-rose-50/20"
                                )}>
                                  <td className="px-6 py-4">
                                    <div className="flex items-center gap-3">
                                      <div className={cn(
                                        "w-9 h-9 bg-gradient-to-br rounded-xl flex items-center justify-center text-xs font-black text-slate-500 shadow-inner",
                                        u.isBlocked ? "from-rose-100 to-rose-200" : "from-slate-100 to-slate-200"
                                      )}>
                                        {u.displayName ? u.displayName.charAt(0).toUpperCase() : u.email.charAt(0).toUpperCase()}
                                      </div>
                                      <div>
                                        <div className="flex items-center gap-2">
                                          <p className="font-bold text-slate-800 text-sm">{u.displayName || u.email.split('@')[0]}</p>
                                          {u.isBlocked && (
                                            <span className="bg-rose-100 text-rose-600 text-[8px] font-black px-1.5 py-0.5 rounded-full uppercase tracking-tighter">Bị chặn</span>
                                          )}
                                        </div>
                                        <p className="text-[10px] text-slate-400 font-medium">{u.email}</p>
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-6 py-4">
                                    <span className={cn(
                                      "px-2.5 py-1 rounded-lg text-[9px] font-black uppercase tracking-wider shadow-sm",
                                      u.role === 'admin' 
                                        ? "bg-amber-50 text-amber-600 border border-amber-100" 
                                        : "bg-indigo-50 text-indigo-600 border border-indigo-100"
                                    )}>
                                      {u.role === 'admin' ? 'Quản trị viên' : 'Thành viên'}
                                    </span>
                                  </td>
                                  <td className="px-6 py-4">
                                    <div className="flex flex-col">
                                      <span className="text-slate-600 font-medium">
                                        {u.createdAt ? (typeof u.createdAt === 'string' ? new Date(u.createdAt).toLocaleDateString('vi-VN') : (u.createdAt._seconds ? new Date(u.createdAt._seconds * 1000).toLocaleDateString('vi-VN') : 'N/A')) : 'N/A'}
                                      </span>
                                      <span className="text-[9px] text-slate-300">
                                        {u.uid.substring(0, 8)}...
                                      </span>
                                    </div>
                                  </td>
                                  <td className="px-6 py-4 text-right">
                                    <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                      <button 
                                        onClick={() => sendAdminPasswordResetEmail(u.email)}
                                        className="p-2 hover:bg-indigo-50 text-indigo-600 rounded-lg transition-colors"
                                        title="Gửi email đặt lại mật khẩu"
                                      >
                                        <Mail className="w-4 h-4" />
                                      </button>
                                      <button 
                                        onClick={async () => {
                                          const newPass = "12345678"; // Default reset password to avoid prompt()
                                          try {
                                            await resetUserPassword(u.uid, newPass);
                                          } catch (e: any) {
                                            console.error(e.message);
                                          }
                                        }}
                                        className="p-2 hover:bg-amber-50 text-amber-600 rounded-lg transition-colors"
                                        title="Đặt lại mật khẩu trực tiếp"
                                      >
                                        <KeyRound className="w-4 h-4" />
                                      </button>
                                      <button 
                                        onClick={() => updateUserRole(u.uid, u.email, u.role === 'admin' ? 'user' : 'admin')}
                                        className={cn(
                                          "p-2 rounded-lg transition-colors",
                                          u.role === 'admin' ? "hover:bg-indigo-50 text-indigo-600" : "hover:bg-amber-50 text-amber-600"
                                        )}
                                        title={u.role === 'admin' ? "Hạ cấp xuống Thành viên" : "Thăng cấp lên Quản trị viên"}
                                      >
                                        {u.role === 'admin' ? <UserIcon className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
                                      </button>
                                      <button 
                                        onClick={() => toggleBlockUser(u.uid, u.email, u.isBlocked)}
                                        className={cn(
                                          "p-2 rounded-lg transition-colors",
                                          u.isBlocked ? "hover:bg-emerald-50 text-emerald-500" : "hover:bg-rose-50 text-rose-500"
                                        )}
                                        title={u.isBlocked ? "Bỏ chặn người dùng" : "Chặn người dùng"}
                                      >
                                        {u.isBlocked ? <ShieldCheck className="w-4 h-4" /> : <ShieldAlert className="w-4 h-4" />}
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </section>
                </div>

              <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end">
                <button 
                  onClick={() => setShowAdminPanel(false)}
                  className="px-6 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl text-xs font-bold hover:bg-slate-50 transition-all"
                >
                  Đóng
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Footer Info */}
      {!pdfDoc && (
        <footer className="h-12 border-t border-slate-200 bg-white flex items-center justify-center px-6 shrink-0">
          <p className="text-[10px] text-slate-400 font-medium uppercase tracking-[0.2em]">
            Copyright © Dr. Hoang Hiep • Medical Grade Translation
          </p>
        </footer>
      )}
    </div>
    
    {/* Toast Notification */}
    <AnimatePresence>
      {toast && (
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.95 }}
          className={cn(
            "fixed bottom-8 left-1/2 -translate-x-1/2 z-[9999] px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 border backdrop-blur-md",
            toast.type === 'success' ? "bg-emerald-50/90 border-emerald-100 text-emerald-800" : 
            toast.type === 'error' ? "bg-rose-50/90 border-rose-100 text-rose-800" : 
            "bg-slate-800/90 border-slate-700 text-white"
          )}
        >
          {toast.type === 'success' && <Check className="w-4 h-4" />}
          {toast.type === 'error' && <AlertCircle className="w-4 h-4" />}
          {toast.type === 'info' && <Activity className="w-4 h-4" />}
          <span className="text-xs font-bold">{toast.message}</span>
        </motion.div>
      )}
    </AnimatePresence>

    </ErrorBoundary>
  );
}
