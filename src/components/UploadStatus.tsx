import React from 'react';
import { Loader2, CheckCircle2, XCircle, FileText, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

export interface UploadTask {
  id: string;
  fileName: string;
  status: 'uploading' | 'success' | 'error';
  progress: number;
}

interface UploadStatusProps {
  tasks: UploadTask[];
  onDismiss: (id: string) => void;
}

export const UploadStatus: React.FC<UploadStatusProps> = ({ tasks, onDismiss }) => {
  if (tasks.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[200] w-80 space-y-3">
      <AnimatePresence>
        {tasks.map((task) => (
          <motion.div
            key={task.id}
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
            className="bg-white rounded-2xl shadow-2xl border border-slate-100 overflow-hidden"
          >
            <div className="p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className={
                  task.status === 'uploading' ? 'bg-indigo-50 p-2 rounded-xl' :
                  task.status === 'success' ? 'bg-emerald-50 p-2 rounded-xl' :
                  'bg-rose-50 p-2 rounded-xl'
                }>
                  {task.status === 'uploading' ? (
                    <Loader2 className="w-5 h-5 text-indigo-600 animate-spin" />
                  ) : task.status === 'success' ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  ) : (
                    <XCircle className="w-5 h-5 text-rose-600" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-slate-800 truncate">{task.fileName}</p>
                  <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">
                    {task.status === 'uploading' ? 'Đang tải lên...' : 
                     task.status === 'success' ? 'Hoàn tất' : 'Lỗi tải lên'}
                  </p>
                </div>
                {(task.status === 'success' || task.status === 'error') && (
                  <button 
                    onClick={() => onDismiss(task.id)}
                    className="p-1 hover:bg-slate-50 rounded-lg transition-colors"
                  >
                    <X className="w-4 h-4 text-slate-400" />
                  </button>
                )}
              </div>
              
              {task.status === 'uploading' && (
                <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                  <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: '100%' }}
                    transition={{ duration: 10, ease: "linear" }}
                    className="h-full bg-indigo-600"
                  />
                </div>
              )}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};
