
import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isActive: boolean;
}

export const Visualizer: React.FC<VisualizerProps> = ({ isActive }) => {
  const bars = Array.from({ length: 12 });

  return (
    <div className="flex items-center justify-center gap-1 h-12">
      {bars.map((_, i) => (
        <div
          key={i}
          className={`w-1 bg-amber-400 rounded-full transition-all duration-300 ${
            isActive 
              ? 'animate-pulse' 
              : 'h-2'
          }`}
          style={{
            height: isActive ? `${Math.random() * 100}%` : '8px',
            animationDelay: `${i * 0.1}s`
          }}
        />
      ))}
    </div>
  );
};
