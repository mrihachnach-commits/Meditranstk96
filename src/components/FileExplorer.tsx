import React, { useState, useEffect } from 'react';
import { 
  Folder, 
  FileText, 
  Plus, 
  FolderPlus, 
  Upload, 
  ChevronRight, 
  Home, 
  MoreVertical, 
  Trash2, 
  Move, 
  Download, 
  Edit,
  Loader2,
  Search,
  ArrowLeft,
  X,
  ArrowUpDown,
  SortAsc,
  SortDesc,
  Clock,
  Type
} from 'lucide-react';
import { 
  db, 
  collection, 
  addDoc, 
  doc, 
  setDoc, 
  getDoc, 
  getDocs, 
  query, 
  where, 
  onSnapshot, 
  deleteDoc, 
  updateDoc, 
  serverTimestamp,
  auth,
  OperationType,
  handleFirestoreError
} from '../firebase';
import { cn } from '../lib/utils';
import { motion, AnimatePresence } from 'motion/react';

interface FolderData {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: any;
}

export interface FileData {
  id: string;
  name: string;
  folderId: string | null;
  token: string;
  downloadUrl: string;
  size: number;
  type: string;
  createdAt: any;
}

interface FileExplorerProps {
  onFileSelect: (file: FileData) => void;
  onUploadStart: (file: File, folderId: string | null) => void;
  onLocalFileOpen: (file: File) => void;
}

export const FileExplorer: React.FC<FileExplorerProps> = ({ onFileSelect, onUploadStart, onLocalFileOpen }) => {
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderData[]>([]);
  const [files, setFiles] = useState<FileData[]>([]);
  const [loading, setLoading] = useState(true);
  const [path, setPath] = useState<{id: string | null, name: string}[]>([{id: null, name: 'Root'}]);
  
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  
  const [showRenameModal, setShowRenameModal] = useState<{id: string, name: string, type: 'file' | 'folder'} | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const [showDeleteConfirm, setShowDeleteConfirm] = useState<{id: string, type: 'file' | 'folder', name: string} | null>(null);
  
  const [showMoveModal, setShowMoveModal] = useState<{id: string, type: 'file' | 'folder'} | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'date' | 'size'>('date');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const [openingFileId, setOpeningFileId] = useState<string | null>(null);

  const user = auth.currentUser;

  useEffect(() => {
    if (!user) return;

    const foldersQuery = query(
      collection(db, `users/${user.uid}/folders`),
      where('parentId', '==', currentFolderId)
    );

    const filesQuery = query(
      collection(db, `users/${user.uid}/documents`),
      where('folderId', '==', currentFolderId)
    );

    const unsubscribeFolders = onSnapshot(foldersQuery, (snapshot) => {
      const folderList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as FolderData));
      setFolders(folderList);
      setLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}/folders`);
    });

    const unsubscribeFiles = onSnapshot(filesQuery, (snapshot) => {
      const fileList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as FileData));
      setFiles(fileList);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}/documents`);
    });

    return () => {
      unsubscribeFolders();
      unsubscribeFiles();
    };
  }, [user, currentFolderId]);

  // Reset opening state if folders change (e.g. navigation)
  useEffect(() => {
    setOpeningFileId(null);
  }, [currentFolderId]);

  const handleCreateFolder = async () => {
    if (!user || !newFolderName.trim()) return;
    
    try {
      await addDoc(collection(db, `users/${user.uid}/folders`), {
        name: newFolderName,
        parentId: currentFolderId,
        createdAt: serverTimestamp()
      });
      setNewFolderName('');
      setShowNewFolderModal(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `users/${user.uid}/folders`);
    }
  };

  const handleLocalOpen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    onLocalFileOpen(file);
    e.target.value = '';
  };

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    onUploadStart(file, currentFolderId);
    // Reset input
    e.target.value = '';
  };

  const handleDeleteItem = async () => {
    if (!user || !showDeleteConfirm) return;

    try {
      const collectionName = showDeleteConfirm.type === 'file' ? 'documents' : 'folders';
      const path = `users/${user.uid}/${collectionName}/${showDeleteConfirm.id}`;
      await deleteDoc(doc(db, `users/${user.uid}/${collectionName}`, showDeleteConfirm.id));
      setShowDeleteConfirm(null);
    } catch (error) {
      const collectionName = showDeleteConfirm.type === 'file' ? 'documents' : 'folders';
      handleFirestoreError(error, OperationType.DELETE, `users/${user.uid}/${collectionName}/${showDeleteConfirm.id}`);
    }
  };

  const handleRename = async () => {
    if (!user || !showRenameModal || !renameValue.trim()) return;

    try {
      const collectionName = showRenameModal.type === 'file' ? 'documents' : 'folders';
      const path = `users/${user.uid}/${collectionName}/${showRenameModal.id}`;
      await updateDoc(doc(db, `users/${user.uid}/${collectionName}`, showRenameModal.id), {
        name: renameValue.trim()
      });
      setShowRenameModal(null);
      setRenameValue('');
    } catch (error) {
      const collectionName = showRenameModal.type === 'file' ? 'documents' : 'folders';
      handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}/${collectionName}/${showRenameModal.id}`);
    }
  };

  const handleMoveItem = async (targetFolderId: string | null) => {
    if (!user || !showMoveModal) return;

    try {
      const collectionName = showMoveModal.type === 'file' ? 'documents' : 'folders';
      const path = `users/${user.uid}/${collectionName}/${showMoveModal.id}`;
      await updateDoc(doc(db, `users/${user.uid}/${collectionName}`, showMoveModal.id), {
        folderId: targetFolderId, // for files
        parentId: targetFolderId  // for folders
      });
      setShowMoveModal(null);
    } catch (error) {
      const collectionName = showMoveModal.type === 'file' ? 'documents' : 'folders';
      handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}/${collectionName}/${showMoveModal.id}`);
    }
  };

  const navigateToFolder = async (folderId: string | null, folderName: string) => {
    if (folderId === null) {
      setPath([{id: null, name: 'Root'}]);
    } else {
      // Build path
      const newPath = [...path];
      const index = newPath.findIndex(p => p.id === folderId);
      if (index !== -1) {
        setPath(newPath.slice(0, index + 1));
      } else {
        setPath([...newPath, {id: folderId, name: folderName}]);
      }
    }
    setCurrentFolderId(folderId);
  };

  const sortedFolders = [...folders]
    .filter(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === 'name') {
        return sortOrder === 'asc' 
          ? a.name.localeCompare(b.name)
          : b.name.localeCompare(a.name);
      } else {
        // Default to date for folders if size is selected
        const dateA = a.createdAt?.toDate?.() || new Date(a.createdAt);
        const dateB = b.createdAt?.toDate?.() || new Date(b.createdAt);
        return sortOrder === 'asc' ? dateA - dateB : dateB - dateA;
      }
    });

  const sortedFiles = [...files]
    .filter(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === 'name') {
        return sortOrder === 'asc' 
          ? a.name.localeCompare(b.name)
          : b.name.localeCompare(a.name);
      } else if (sortBy === 'size') {
        return sortOrder === 'asc' ? a.size - b.size : b.size - a.size;
      } else {
        const dateA = a.createdAt?.toDate?.() || new Date(a.createdAt);
        const dateB = b.createdAt?.toDate?.() || new Date(b.createdAt);
        return sortOrder === 'asc' ? dateA - dateB : dateB - dateA;
      }
    });

  const toggleSort = (type: 'name' | 'date' | 'size') => {
    if (sortBy === type) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(type);
      setSortOrder(type === 'name' ? 'asc' : 'desc');
    }
  };

  return (
    <div className="flex flex-col h-full bg-white rounded-3xl shadow-xl overflow-hidden border border-slate-100">
      {/* Header */}
      <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-white sticky top-0 z-10">
        <div className="flex items-center gap-4">
          <div className="bg-indigo-600 p-2.5 rounded-2xl shadow-lg shadow-indigo-100">
            <Folder className="text-white w-6 h-6" />
          </div>
          <div>
            <h2 className="text-xl font-display font-bold text-slate-800">Quản lý tài liệu</h2>
            <div className="flex items-center gap-1 mt-0.5">
              {path.map((p, i) => (
                <React.Fragment key={p.id || 'root'}>
                  <button 
                    onClick={() => navigateToFolder(p.id, p.name)}
                    className="text-[10px] font-bold text-slate-400 hover:text-indigo-600 transition-colors uppercase tracking-widest"
                  >
                    {p.name}
                  </button>
                  {i < path.length - 1 && <ChevronRight className="w-3 h-3 text-slate-300" />}
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative hidden sm:block">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              type="text" 
              placeholder="Tìm kiếm..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 pr-4 py-2 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all w-40"
            />
          </div>

          <div className="flex bg-slate-50 p-1 rounded-xl border border-slate-100">
            <button 
              onClick={() => toggleSort('name')}
              className={cn(
                "p-1.5 rounded-lg transition-all flex items-center gap-1",
                sortBy === 'name' ? "bg-white shadow-sm text-indigo-600" : "text-slate-400 hover:text-slate-600"
              )}
              title="Sắp xếp theo tên"
            >
              <Type className="w-4 h-4" />
              {sortBy === 'name' && (sortOrder === 'asc' ? <SortAsc className="w-3 h-3" /> : <SortDesc className="w-3 h-3" />)}
            </button>
            <button 
              onClick={() => toggleSort('date')}
              className={cn(
                "p-1.5 rounded-lg transition-all flex items-center gap-1",
                sortBy === 'date' ? "bg-white shadow-sm text-indigo-600" : "text-slate-400 hover:text-slate-600"
              )}
              title="Sắp xếp theo thời gian"
            >
              <Clock className="w-4 h-4" />
              {sortBy === 'date' && (sortOrder === 'asc' ? <SortAsc className="w-3 h-3" /> : <SortDesc className="w-3 h-3" />)}
            </button>
            <button 
              onClick={() => toggleSort('size')}
              className={cn(
                "p-1.5 rounded-lg transition-all flex items-center gap-1",
                sortBy === 'size' ? "bg-white shadow-sm text-indigo-600" : "text-slate-400 hover:text-slate-600"
              )}
              title="Sắp xếp theo dung lượng"
            >
              <ArrowUpDown className="w-4 h-4" />
              {sortBy === 'size' && (sortOrder === 'asc' ? <SortAsc className="w-3 h-3" /> : <SortDesc className="w-3 h-3" />)}
            </button>
          </div>

          <button 
            onClick={() => setShowNewFolderModal(true)}
            className="p-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 transition-all shadow-sm"
            title="Tạo thư mục mới"
          >
            <FolderPlus className="w-5 h-5" />
          </button>
          
          <label className="p-2.5 bg-white border border-slate-200 text-indigo-600 rounded-xl hover:bg-slate-50 transition-all shadow-sm cursor-pointer" title="Mở tệp cục bộ (Không tải lên)">
            <FileText className="w-5 h-5" />
            <input type="file" className="hidden" accept=".pdf" onChange={handleLocalOpen} />
          </label>

          <label className="p-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 cursor-pointer" title="Tải lên đám mây">
            <Upload className="w-5 h-5" />
            <input type="file" className="hidden" accept=".pdf" onChange={handleUploadFile} />
          </label>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 no-scrollbar">
        {loading ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-4">
            <Loader2 className="w-10 h-10 animate-spin text-indigo-500" />
            <p className="text-sm font-medium">Đang tải tài liệu...</p>
          </div>
        ) : (folders.length === 0 && files.length === 0) ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-300 gap-6">
            <div className="bg-slate-50 p-8 rounded-[40px] border border-slate-100">
              <Upload className="w-16 h-16 opacity-20" />
            </div>
            <div className="text-center">
              <p className="text-lg font-bold text-slate-400">Thư mục trống</p>
              <p className="text-sm">Tải lên file PDF hoặc tạo thư mục mới để bắt đầu</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {/* Folders */}
            {sortedFolders.map(folder => (
              <motion.div 
                key={folder.id}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="group relative bg-white border border-slate-100 rounded-2xl p-4 hover:border-indigo-200 hover:shadow-xl hover:shadow-indigo-50 transition-all cursor-pointer"
                onClick={() => navigateToFolder(folder.id, folder.name)}
              >
                <div className="flex flex-col items-center gap-3">
                  <div className="bg-amber-100 p-3 rounded-xl group-hover:bg-amber-200 transition-colors">
                    <Folder className="text-amber-600 w-8 h-8" />
                  </div>
                  <span className="text-xs font-bold text-slate-700 text-center truncate w-full">
                    {folder.name}
                  </span>
                </div>
                <div className="absolute top-2 right-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-all">
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMoveModal({ id: folder.id, type: 'folder' });
                    }}
                    className="p-1.5 bg-white rounded-lg text-slate-300 hover:text-indigo-500 shadow-sm border border-slate-100"
                    title="Di chuyển"
                  >
                    <Move className="w-3.5 h-3.5" />
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenameValue(folder.name);
                      setShowRenameModal({ id: folder.id, name: folder.name, type: 'folder' });
                    }}
                    className="p-1.5 bg-white rounded-lg text-slate-300 hover:text-indigo-500 shadow-sm border border-slate-100"
                    title="Đổi tên"
                  >
                    <Edit className="w-3.5 h-3.5" />
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowDeleteConfirm({ id: folder.id, type: 'folder', name: folder.name });
                    }}
                    className="p-1.5 bg-white rounded-lg text-slate-300 hover:text-rose-500 shadow-sm border border-slate-100"
                    title="Xóa"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </motion.div>
            ))}

            {/* Files */}
            {sortedFiles.map(file => (
              <motion.div 
                key={file.id}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className={cn(
                  "group relative bg-white border border-slate-100 rounded-2xl p-4 hover:border-indigo-200 hover:shadow-xl hover:shadow-indigo-50 transition-all cursor-pointer",
                  openingFileId === file.id && "border-indigo-500 shadow-indigo-50 bg-indigo-50/30"
                )}
                onClick={() => {
                  if (openingFileId) return;
                  setOpeningFileId(file.id);
                  onFileSelect(file);
                }}
              >
                <div className="flex flex-col items-center gap-3">
                  <div className={cn(
                    "p-3 rounded-xl transition-colors",
                    openingFileId === file.id ? "bg-indigo-600" : "bg-indigo-50 group-hover:bg-indigo-100"
                  )}>
                    {openingFileId === file.id ? (
                      <Loader2 className="w-8 h-8 animate-spin text-white" />
                    ) : (
                      <FileText className="text-indigo-600 w-8 h-8" />
                    )}
                  </div>
                  <span className={cn(
                    "text-xs font-bold text-center truncate w-full",
                    openingFileId === file.id ? "text-indigo-700" : "text-slate-700"
                  )}>
                    {file.name}
                  </span>
                  <span className="text-[10px] text-slate-400 font-medium">
                    {(file.size / 1024 / 1024).toFixed(2)} MB
                  </span>
                </div>
                <div className="absolute top-2 right-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-all">
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMoveModal({ id: file.id, type: 'file' });
                    }}
                    className="p-1.5 bg-white rounded-lg text-slate-300 hover:text-indigo-500 shadow-sm border border-slate-100"
                    title="Di chuyển"
                  >
                    <Move className="w-3.5 h-3.5" />
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenameValue(file.name);
                      setShowRenameModal({ id: file.id, name: file.name, type: 'file' });
                    }}
                    className="p-1.5 bg-white rounded-lg text-slate-300 hover:text-indigo-500 shadow-sm border border-slate-100"
                    title="Đổi tên"
                  >
                    <Edit className="w-3.5 h-3.5" />
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowDeleteConfirm({ id: file.id, type: 'file', name: file.name });
                    }}
                    className="p-1.5 bg-white rounded-lg text-slate-300 hover:text-rose-500 shadow-sm border border-slate-100"
                    title="Xóa"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* Move Modal */}
      <AnimatePresence>
        {showMoveModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowMoveModal(null)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-xl font-display font-bold text-slate-800">Di chuyển tới...</h3>
                <button onClick={() => setShowMoveModal(null)} className="p-2 hover:bg-slate-50 rounded-full transition-colors">
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                <button 
                  onClick={() => handleMoveItem(null)}
                  className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 rounded-2xl transition-all text-left group"
                >
                  <div className="bg-slate-100 p-2 rounded-xl group-hover:bg-indigo-100 transition-colors">
                    <Home className="w-5 h-5 text-slate-500 group-hover:text-indigo-600" />
                  </div>
                  <span className="text-sm font-bold text-slate-700">Root</span>
                </button>
                {folders.filter(f => f.id !== showMoveModal.id).map(folder => (
                  <button 
                    key={folder.id}
                    onClick={() => handleMoveItem(folder.id)}
                    className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 rounded-2xl transition-all text-left group"
                  >
                    <div className="bg-amber-50 p-2 rounded-xl group-hover:bg-amber-100 transition-colors">
                      <Folder className="w-5 h-5 text-amber-600" />
                    </div>
                    <span className="text-sm font-bold text-slate-700">{folder.name}</span>
                  </button>
                ))}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Rename Modal */}
      <AnimatePresence>
        {showRenameModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowRenameModal(null)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white w-full max-w-sm rounded-3xl shadow-2xl overflow-hidden p-8"
            >
              <h3 className="text-xl font-display font-bold text-slate-800 mb-6">Đổi tên {showRenameModal.type === 'file' ? 'tệp' : 'thư mục'}</h3>
              <input 
                type="text" 
                placeholder="Tên mới" 
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                autoFocus
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all text-sm mb-6"
              />
              <div className="flex gap-3">
                <button 
                  onClick={() => setShowRenameModal(null)}
                  className="flex-1 px-6 py-3 rounded-xl text-sm font-bold text-slate-500 hover:bg-slate-100 transition-colors"
                >
                  Hủy
                </button>
                <button 
                  onClick={handleRename}
                  className="flex-1 px-6 py-3 rounded-xl text-sm font-bold bg-indigo-600 text-white hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100"
                >
                  Lưu
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {showDeleteConfirm && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowDeleteConfirm(null)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white w-full max-w-sm rounded-3xl shadow-2xl overflow-hidden p-8"
            >
              <div className="bg-rose-50 w-16 h-16 rounded-2xl flex items-center justify-center mb-6 mx-auto">
                <Trash2 className="w-8 h-8 text-rose-500" />
              </div>
              <h3 className="text-xl font-display font-bold text-slate-800 mb-2 text-center">Xác nhận xóa?</h3>
              <p className="text-slate-500 text-sm text-center mb-8">
                Bạn có chắc chắn muốn xóa {showDeleteConfirm.type === 'file' ? 'tệp' : 'thư mục'} <span className="font-bold text-slate-700">"{showDeleteConfirm.name}"</span>? Hành động này không thể hoàn tác.
              </p>
              <div className="flex gap-3">
                <button 
                  onClick={() => setShowDeleteConfirm(null)}
                  className="flex-1 px-6 py-3 rounded-xl text-sm font-bold text-slate-500 hover:bg-slate-100 transition-colors"
                >
                  Hủy
                </button>
                <button 
                  onClick={handleDeleteItem}
                  className="flex-1 px-6 py-3 rounded-xl text-sm font-bold bg-rose-500 text-white hover:bg-rose-600 transition-all shadow-lg shadow-rose-100"
                >
                  Xóa ngay
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* New Folder Modal */}
      <AnimatePresence>
        {showNewFolderModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowNewFolderModal(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white w-full max-w-sm rounded-3xl shadow-2xl overflow-hidden p-8"
            >
              <h3 className="text-xl font-display font-bold text-slate-800 mb-6">Tạo thư mục mới</h3>
              <input 
                type="text" 
                placeholder="Tên thư mục" 
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                autoFocus
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all text-sm mb-6"
              />
              <div className="flex gap-3">
                <button 
                  onClick={() => setShowNewFolderModal(false)}
                  className="flex-1 px-6 py-3 rounded-xl text-sm font-bold text-slate-500 hover:bg-slate-100 transition-colors"
                >
                  Hủy
                </button>
                <button 
                  onClick={handleCreateFolder}
                  className="flex-1 px-6 py-3 rounded-xl text-sm font-bold bg-indigo-600 text-white hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100"
                >
                  Tạo mới
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
