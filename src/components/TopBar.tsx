import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Activity, LogOut } from 'lucide-react-native';
import { Gradient } from './Gradient';

interface Props {
  onSignOut: () => void;
}

export const TopBar: React.FC<Props> = ({ onSignOut }) => {
  return (
    <View className="w-full bg-white/90 border-b border-slate-200/80">
      <View className="px-4 h-16 flex-row items-center justify-between">
        {/* Wordmark */}
        <View className="flex-row items-center gap-2">
          <Gradient
            direction="tr"
            from="#004ac6"
            to="#06b6d4"
            className="w-8 h-8 rounded-xl items-center justify-center"
          >
            <Activity size={16} color="#ffffff" strokeWidth={2.5} />
          </Gradient>
          <Text className="text-xl font-sans-extrabold tracking-tight text-[#131b2e]">
            Ergo
            <Text className="text-[#004ac6] font-sans-extrabold">Focus</Text>
          </Text>
        </View>

        {/* Sign Out */}
        <Pressable
          onPress={onSignOut}
          accessibilityLabel="Cerrar sesión"
          className="p-2 rounded-full border border-slate-200"
        >
          <LogOut size={16} color="#64748b" />
        </Pressable>
      </View>
    </View>
  );
};