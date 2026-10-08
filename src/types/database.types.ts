export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: '14.18';
  };
  public: {
    Tables: {
      profiles: {
        Row: {
          role: 'free' | 'pro';
          stripe_customer_id: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          role?: 'free' | 'pro';
          stripe_customer_id?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          role?: 'free' | 'pro';
          stripe_customer_id?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      push_tokens: {
        Row: {
          created_at: string;
          token: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          token: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          token?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      sensor_daily: {
        Row: {
          avg: number;
          day: string;
          sample_count: number;
          sensor: 'light' | 'sound' | 'movement' | 'gyro';
          updated_at: string;
          user_id: string;
        };
        Insert: {
          avg: number;
          day: string;
          sample_count: number;
          sensor: 'light' | 'sound' | 'movement' | 'gyro';
          updated_at?: string;
          user_id: string;
        };
        Update: {
          avg?: number;
          day?: string;
          sample_count?: number;
          sensor?: 'light' | 'sound' | 'movement' | 'gyro';
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};
