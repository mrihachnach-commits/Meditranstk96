import React from 'react';

interface LogoProps {
  className?: string;
  size?: number;
}

export const Logo: React.FC<LogoProps> = ({ className = "", size = 32 }) => {
  return (
    <div className={`relative flex items-center justify-center ${className}`} style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full"
      >
        {/* Main Medical Cross Shape with Rounded Corners */}
        <path
          d="M35 15C35 12.2386 37.2386 10 40 10H60C62.7614 10 65 12.2386 65 15V35H85C87.7614 35 90 37.2386 90 40V60C90 62.7614 87.7614 65 85 65H65V85C65 87.7614 62.7614 90 60 90H40C37.2386 90 35 87.7614 35 85V65H15C12.2386 65 10 62.7614 10 40V40C10 37.2386 12.2386 35 15 35H35V15Z"
          fill="url(#logo-gradient)"
          className="drop-shadow-sm"
        />
        
        {/* AI/Digital Node in the center */}
        <circle cx="50" cy="50" r="12" fill="white" fillOpacity="0.9" />
        <circle cx="50" cy="50" r="8" fill="url(#ai-node-gradient)" />
        
        {/* Connecting lines for AI feel */}
        <path d="M50 38V30" stroke="white" strokeWidth="2" strokeLinecap="round" />
        <path d="M50 62V70" stroke="white" strokeWidth="2" strokeLinecap="round" />
        <path d="M62 50H70" stroke="white" strokeWidth="2" strokeLinecap="round" />
        <path d="M38 50H30" stroke="white" strokeWidth="2" strokeLinecap="round" />
        
        {/* Sparkle/AI effect */}
        <path
          d="M75 25L77 31L83 33L77 35L75 41L73 35L67 33L73 31L75 25Z"
          fill="#FDE047"
          className="animate-pulse"
        />

        <defs>
          <linearGradient id="logo-gradient" x1="10" y1="10" x2="90" y2="90" gradientUnits="userSpaceOnUse">
            <stop stopColor="#0EA5E9" />
            <stop offset="1" stopColor="#6366F1" />
          </linearGradient>
          <linearGradient id="ai-node-gradient" x1="42" y1="42" x2="58" y2="58" gradientUnits="userSpaceOnUse">
            <stop stopColor="#6366F1" />
            <stop offset="1" stopColor="#A855F7" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
};

export const LogoWithText: React.FC<{ className?: string }> = ({ className = "" }) => {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <Logo size={34} />
      <div className="flex flex-col">
        <span className="font-display font-bold text-xl text-slate-800 tracking-tight leading-none">
          MediTrans <span className="text-sky-600">AI</span>
        </span>
        <span className="text-[10px] font-medium text-slate-500 uppercase tracking-[0.2em] mt-0.5">
          Medical Translation
        </span>
      </div>
    </div>
  );
};
