export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      baselines: {
        Row: {
          cadence_days_mad: number | null
          cadence_days_median: number | null
          computed_at: string
          entity_id: string
          event_type: Database["public"]["Enums"]["event_type"]
          id: string
          inputs_hash: string
          method_version: string
          observation_count: number
          reasons: Json
          status: Database["public"]["Enums"]["baseline_status"]
          user_id: string
          window_end: string | null
          window_start: string | null
        }
        Insert: {
          cadence_days_mad?: number | null
          cadence_days_median?: number | null
          computed_at?: string
          entity_id: string
          event_type: Database["public"]["Enums"]["event_type"]
          id?: string
          inputs_hash: string
          method_version: string
          observation_count?: number
          reasons?: Json
          status: Database["public"]["Enums"]["baseline_status"]
          user_id: string
          window_end?: string | null
          window_start?: string | null
        }
        Update: {
          cadence_days_mad?: number | null
          cadence_days_median?: number | null
          computed_at?: string
          entity_id?: string
          event_type?: Database["public"]["Enums"]["event_type"]
          id?: string
          inputs_hash?: string
          method_version?: string
          observation_count?: number
          reasons?: Json
          status?: Database["public"]["Enums"]["baseline_status"]
          user_id?: string
          window_end?: string | null
          window_start?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "baselines_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "entities"
            referencedColumns: ["id"]
          },
        ]
      }
      closures: {
        Row: {
          created_at: string
          id: string
          opportunity_id: string
          response_id: string
          surfaced_at: string | null
          surfaced_message_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          opportunity_id: string
          response_id: string
          surfaced_at?: string | null
          surfaced_message_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          opportunity_id?: string
          response_id?: string
          surfaced_at?: string | null
          surfaced_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "closures_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "reconnect_opportunities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "closures_response_id_fkey"
            columns: ["response_id"]
            isOneToOne: false
            referencedRelation: "family_responses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "closures_surfaced_message_id_fkey"
            columns: ["surfaced_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      consent_grants: {
        Row: {
          expires_at: string
          granted_at: string
          granting_message_id: string | null
          id: string
          opportunity_id: string
          payload_snapshot: Json
          rendered_text_hash: string
          rendered_text_snapshot: string
          revoked_at: string | null
          scope: Json
          used_at: string | null
          user_id: string
        }
        Insert: {
          expires_at: string
          granted_at?: string
          granting_message_id?: string | null
          id?: string
          opportunity_id: string
          payload_snapshot: Json
          rendered_text_hash: string
          rendered_text_snapshot: string
          revoked_at?: string | null
          scope: Json
          used_at?: string | null
          user_id: string
        }
        Update: {
          expires_at?: string
          granted_at?: string
          granting_message_id?: string | null
          id?: string
          opportunity_id?: string
          payload_snapshot?: Json
          rendered_text_hash?: string
          rendered_text_snapshot?: string
          revoked_at?: string | null
          scope?: Json
          used_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "consent_grants_granting_message_id_fkey"
            columns: ["granting_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consent_grants_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "reconnect_opportunities"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          channel: Database["public"]["Enums"]["conversation_channel"]
          id: string
          started_at: string
          user_id: string
        }
        Insert: {
          channel?: Database["public"]["Enums"]["conversation_channel"]
          id?: string
          started_at?: string
          user_id: string
        }
        Update: {
          channel?: Database["public"]["Enums"]["conversation_channel"]
          id?: string
          started_at?: string
          user_id?: string
        }
        Relationships: []
      }
      entities: {
        Row: {
          aliases: string[]
          display_name: string
          first_seen_at: string
          id: string
          last_mentioned_at: string | null
          mention_count: number
          origin: Database["public"]["Enums"]["entity_origin"]
          status: Database["public"]["Enums"]["entity_status"]
          subtype: string | null
          type: Database["public"]["Enums"]["entity_type"]
          user_id: string
        }
        Insert: {
          aliases?: string[]
          display_name: string
          first_seen_at?: string
          id?: string
          last_mentioned_at?: string | null
          mention_count?: number
          origin?: Database["public"]["Enums"]["entity_origin"]
          status?: Database["public"]["Enums"]["entity_status"]
          subtype?: string | null
          type: Database["public"]["Enums"]["entity_type"]
          user_id: string
        }
        Update: {
          aliases?: string[]
          display_name?: string
          first_seen_at?: string
          id?: string
          last_mentioned_at?: string | null
          mention_count?: number
          origin?: Database["public"]["Enums"]["entity_origin"]
          status?: Database["public"]["Enums"]["entity_status"]
          subtype?: string | null
          type?: Database["public"]["Enums"]["entity_type"]
          user_id?: string
        }
        Relationships: []
      }
      episode_entities: {
        Row: {
          entity_id: string
          episode_id: string
        }
        Insert: {
          entity_id: string
          episode_id: string
        }
        Update: {
          entity_id?: string
          episode_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "episode_entities_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "episode_entities_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
        ]
      }
      episodes: {
        Row: {
          created_at: string
          embedding: string | null
          id: string
          occurred_at: string
          occurred_at_precision: Database["public"]["Enums"]["time_precision"]
          salience: number
          source_message_ids: string[]
          summary: string
          user_id: string
        }
        Insert: {
          created_at?: string
          embedding?: string | null
          id?: string
          occurred_at: string
          occurred_at_precision: Database["public"]["Enums"]["time_precision"]
          salience?: number
          source_message_ids?: string[]
          summary: string
          user_id: string
        }
        Update: {
          created_at?: string
          embedding?: string | null
          id?: string
          occurred_at?: string
          occurred_at_precision?: Database["public"]["Enums"]["time_precision"]
          salience?: number
          source_message_ids?: string[]
          summary?: string
          user_id?: string
        }
        Relationships: []
      }
      facts: {
        Row: {
          confidence: number | null
          created_at: string
          evidence_count: number
          id: string
          key: string
          source_conversation_ids: string[]
          source_observation_ids: string[]
          status: Database["public"]["Enums"]["evidence_status"]
          subject_entity_id: string | null
          user_id: string
          value: Json
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          evidence_count?: number
          id?: string
          key: string
          source_conversation_ids?: string[]
          source_observation_ids?: string[]
          status?: Database["public"]["Enums"]["evidence_status"]
          subject_entity_id?: string | null
          user_id: string
          value: Json
        }
        Update: {
          confidence?: number | null
          created_at?: string
          evidence_count?: number
          id?: string
          key?: string
          source_conversation_ids?: string[]
          source_observation_ids?: string[]
          status?: Database["public"]["Enums"]["evidence_status"]
          subject_entity_id?: string | null
          user_id?: string
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "facts_subject_entity_id_fkey"
            columns: ["subject_entity_id"]
            isOneToOne: false
            referencedRelation: "entities"
            referencedColumns: ["id"]
          },
        ]
      }
      family_contacts: {
        Row: {
          address: string
          channel: string
          created_at: string
          display_name: string | null
          entity_id: string
          id: string
          user_id: string
        }
        Insert: {
          address: string
          channel: string
          created_at?: string
          display_name?: string | null
          entity_id: string
          id?: string
          user_id: string
        }
        Update: {
          address?: string
          channel?: string
          created_at?: string
          display_name?: string | null
          entity_id?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "family_contacts_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "entities"
            referencedColumns: ["id"]
          },
        ]
      }
      family_requests: {
        Row: {
          access_token_hash: string
          contact_id: string
          created_at: string
          delivered_at: string | null
          delivery_attempts: number
          id: string
          last_delivery_error: string | null
          opened_at: string | null
          opportunity_id: string
          payload: Json
          rendered_body: string
          rendered_body_hash: string
          status: Database["public"]["Enums"]["family_request_status"]
          token_expires_at: string
        }
        Insert: {
          access_token_hash: string
          contact_id: string
          created_at?: string
          delivered_at?: string | null
          delivery_attempts?: number
          id?: string
          last_delivery_error?: string | null
          opened_at?: string | null
          opportunity_id: string
          payload: Json
          rendered_body: string
          rendered_body_hash: string
          status?: Database["public"]["Enums"]["family_request_status"]
          token_expires_at: string
        }
        Update: {
          access_token_hash?: string
          contact_id?: string
          created_at?: string
          delivered_at?: string | null
          delivery_attempts?: number
          id?: string
          last_delivery_error?: string | null
          opened_at?: string | null
          opportunity_id?: string
          payload?: Json
          rendered_body?: string
          rendered_body_hash?: string
          status?: Database["public"]["Enums"]["family_request_status"]
          token_expires_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "family_requests_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "family_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "family_requests_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "reconnect_opportunities"
            referencedColumns: ["id"]
          },
        ]
      }
      family_responses: {
        Row: {
          id: string
          parsed: Json | null
          raw_body: string
          received_at: string
          request_id: string
        }
        Insert: {
          id?: string
          parsed?: Json | null
          raw_body: string
          received_at?: string
          request_id: string
        }
        Update: {
          id?: string
          parsed?: Json | null
          raw_body?: string
          received_at?: string
          request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "family_responses_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "family_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      interaction_events: {
        Row: {
          certainty: number
          created_at: string
          entity_id: string
          event_type: Database["public"]["Enums"]["event_type"]
          id: string
          ingest_fingerprint: string
          occurred_at: string
          occurred_at_precision: Database["public"]["Enums"]["time_precision"]
          polarity: Database["public"]["Enums"]["event_polarity"]
          reported_at: string
          source_episode_id: string | null
          source_observation_id: string | null
          user_id: string
          window_end: string | null
          window_start: string | null
        }
        Insert: {
          certainty: number
          created_at?: string
          entity_id: string
          event_type: Database["public"]["Enums"]["event_type"]
          id?: string
          ingest_fingerprint: string
          occurred_at: string
          occurred_at_precision: Database["public"]["Enums"]["time_precision"]
          polarity?: Database["public"]["Enums"]["event_polarity"]
          reported_at?: string
          source_episode_id?: string | null
          source_observation_id?: string | null
          user_id: string
          window_end?: string | null
          window_start?: string | null
        }
        Update: {
          certainty?: number
          created_at?: string
          entity_id?: string
          event_type?: Database["public"]["Enums"]["event_type"]
          id?: string
          ingest_fingerprint?: string
          occurred_at?: string
          occurred_at_precision?: Database["public"]["Enums"]["time_precision"]
          polarity?: Database["public"]["Enums"]["event_polarity"]
          reported_at?: string
          source_episode_id?: string | null
          source_observation_id?: string | null
          user_id?: string
          window_end?: string | null
          window_start?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "interaction_events_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interaction_events_source_episode_id_fkey"
            columns: ["source_episode_id"]
            isOneToOne: false
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interaction_events_source_observation_id_fkey"
            columns: ["source_observation_id"]
            isOneToOne: false
            referencedRelation: "observations"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          attempts: number
          completed_at: string | null
          created_at: string
          id: string
          key: string
          kind: Database["public"]["Enums"]["job_kind"]
          last_error: string | null
          payload: Json | null
          run_after: string
        }
        Insert: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          id?: string
          key: string
          kind: Database["public"]["Enums"]["job_kind"]
          last_error?: string | null
          payload?: Json | null
          run_after?: string
        }
        Update: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          id?: string
          key?: string
          kind?: Database["public"]["Enums"]["job_kind"]
          last_error?: string | null
          payload?: Json | null
          run_after?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          audio_url: string | null
          content: string
          conversation_id: string
          created_at: string
          id: string
          modality: Database["public"]["Enums"]["message_modality"]
          role: Database["public"]["Enums"]["message_role"]
          transcript_confidence: number | null
        }
        Insert: {
          audio_url?: string | null
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          modality?: Database["public"]["Enums"]["message_modality"]
          role: Database["public"]["Enums"]["message_role"]
          transcript_confidence?: number | null
        }
        Update: {
          audio_url?: string | null
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          modality?: Database["public"]["Enums"]["message_modality"]
          role?: Database["public"]["Enums"]["message_role"]
          transcript_confidence?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      observations: {
        Row: {
          confidence: number | null
          created_at: string
          id: string
          kind: string
          model: string | null
          payload: Json
          processed_at: string | null
          prompt_id: string | null
          resolution: Json | null
          source_message_id: string
          source_span: string | null
          user_id: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          id?: string
          kind: string
          model?: string | null
          payload: Json
          processed_at?: string | null
          prompt_id?: string | null
          resolution?: Json | null
          source_message_id: string
          source_span?: string | null
          user_id: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          id?: string
          kind?: string
          model?: string | null
          payload?: Json
          processed_at?: string | null
          prompt_id?: string | null
          resolution?: Json | null
          source_message_id?: string
          source_span?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "observations_source_message_id_fkey"
            columns: ["source_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          family_display_name: string | null
          id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          family_display_name?: string | null
          id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          family_display_name?: string | null
          id?: string
        }
        Relationships: []
      }
      reconnect_opportunities: {
        Row: {
          created_at: string
          entity_id: string
          expires_at: string
          id: string
          offered_at: string | null
          proposal: Json
          rendered_text: string | null
          rendered_text_hash: string | null
          resolved_at: string | null
          share_payload: Json | null
          signal_id: string
          status: Database["public"]["Enums"]["opportunity_status"]
          user_id: string
        }
        Insert: {
          created_at?: string
          entity_id: string
          expires_at: string
          id?: string
          offered_at?: string | null
          proposal: Json
          rendered_text?: string | null
          rendered_text_hash?: string | null
          resolved_at?: string | null
          share_payload?: Json | null
          signal_id: string
          status?: Database["public"]["Enums"]["opportunity_status"]
          user_id: string
        }
        Update: {
          created_at?: string
          entity_id?: string
          expires_at?: string
          id?: string
          offered_at?: string | null
          proposal?: Json
          rendered_text?: string | null
          rendered_text_hash?: string | null
          resolved_at?: string | null
          share_payload?: Json | null
          signal_id?: string
          status?: Database["public"]["Enums"]["opportunity_status"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reconnect_opportunities_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reconnect_opportunities_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      relationships: {
        Row: {
          confidence: number | null
          evidence_count: number
          first_observed_at: string
          from_entity_id: string | null
          id: string
          kind: string
          label_raw: string | null
          last_confirmed_at: string | null
          source_conversation_ids: string[]
          source_observation_ids: string[]
          status: Database["public"]["Enums"]["evidence_status"]
          to_entity_id: string
          user_id: string
        }
        Insert: {
          confidence?: number | null
          evidence_count?: number
          first_observed_at?: string
          from_entity_id?: string | null
          id?: string
          kind: string
          label_raw?: string | null
          last_confirmed_at?: string | null
          source_conversation_ids?: string[]
          source_observation_ids?: string[]
          status?: Database["public"]["Enums"]["evidence_status"]
          to_entity_id: string
          user_id: string
        }
        Update: {
          confidence?: number | null
          evidence_count?: number
          first_observed_at?: string
          from_entity_id?: string | null
          id?: string
          kind?: string
          label_raw?: string | null
          last_confirmed_at?: string | null
          source_conversation_ids?: string[]
          source_observation_ids?: string[]
          status?: Database["public"]["Enums"]["evidence_status"]
          to_entity_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "relationships_from_entity_id_fkey"
            columns: ["from_entity_id"]
            isOneToOne: false
            referencedRelation: "entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "relationships_to_entity_id_fkey"
            columns: ["to_entity_id"]
            isOneToOne: false
            referencedRelation: "entities"
            referencedColumns: ["id"]
          },
        ]
      }
      signals: {
        Row: {
          baseline_id: string | null
          detected_at: string
          entity_id: string
          explanation: Json
          id: string
          materialized_at: string | null
          score: number | null
          signal_type: Database["public"]["Enums"]["signal_type"]
          status: Database["public"]["Enums"]["signal_status"]
          suppression_reason: string | null
          user_id: string
        }
        Insert: {
          baseline_id?: string | null
          detected_at?: string
          entity_id: string
          explanation: Json
          id?: string
          materialized_at?: string | null
          score?: number | null
          signal_type: Database["public"]["Enums"]["signal_type"]
          status?: Database["public"]["Enums"]["signal_status"]
          suppression_reason?: string | null
          user_id: string
        }
        Update: {
          baseline_id?: string | null
          detected_at?: string
          entity_id?: string
          explanation?: Json
          id?: string
          materialized_at?: string | null
          score?: number | null
          signal_type?: Database["public"]["Enums"]["signal_type"]
          status?: Database["public"]["Enums"]["signal_status"]
          suppression_reason?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "signals_baseline_id_fkey"
            columns: ["baseline_id"]
            isOneToOne: false
            referencedRelation: "baselines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signals_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "entities"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_ingest_jobs: {
        Args: { p_lease_seconds?: number; p_limit?: number }
        Returns: {
          attempts: number
          completed_at: string | null
          created_at: string
          id: string
          key: string
          kind: Database["public"]["Enums"]["job_kind"]
          last_error: string | null
          payload: Json | null
          run_after: string
        }[]
        SetofOptions: {
          from: "*"
          to: "jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      create_authorized_family_request: {
        Args: {
          p_access_token_hash: string
          p_contact_id: string
          p_now?: string
          p_opportunity_id: string
          p_payload: Json
          p_rendered_body: string
          p_rendered_body_hash: string
          p_token_expires_at: string
          p_user_id: string
        }
        Returns: Json
      }
      match_episodes: {
        Args: { p_limit?: number; p_query: string; p_user_id: string }
        Returns: {
          id: string
          occurred_at: string
          occurred_at_precision: Database["public"]["Enums"]["time_precision"]
          salience: number
          similarity: number
          summary: string
        }[]
      }
      materialize_signal: {
        Args: {
          p_entity_id: string
          p_expires_at: string
          p_now?: string
          p_proposal: Json
          p_signal_id: string
          p_user_id: string
        }
        Returns: Json
      }
      record_family_response: {
        Args: {
          p_now?: string
          p_parsed: Json
          p_raw_body: string
          p_request_id: string
        }
        Returns: Json
      }
    }
    Enums: {
      baseline_status: "NO_BASELINE" | "IRREGULAR" | "ACTIVE"
      conversation_channel: "text" | "voice"
      entity_origin: "user" | "demo" | "dev"
      entity_status: "active" | "needs_confirmation" | "merged_into"
      entity_type: "person" | "pet" | "place" | "org"
      event_polarity: "positive" | "absence"
      event_type: "visit" | "call" | "message" | "mention" | "outing"
      evidence_status: "candidate" | "confirmed"
      family_request_status: "pending" | "delivered" | "answered" | "expired"
      job_kind: "ingest"
      message_modality: "text" | "voice"
      message_role: "user" | "assistant" | "system"
      opportunity_status:
        | "proposed"
        | "drafted"
        | "offered"
        | "approved"
        | "consumed"
        | "declined"
        | "expired"
      signal_status: "detected" | "materialized" | "suppressed"
      signal_type:
        | "cadence_gap"
        | "user_asserted_absence"
        | "self_reported_wellbeing"
      time_precision: "exact" | "day" | "week" | "unknown"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      baseline_status: ["NO_BASELINE", "IRREGULAR", "ACTIVE"],
      conversation_channel: ["text", "voice"],
      entity_origin: ["user", "demo", "dev"],
      entity_status: ["active", "needs_confirmation", "merged_into"],
      entity_type: ["person", "pet", "place", "org"],
      event_polarity: ["positive", "absence"],
      event_type: ["visit", "call", "message", "mention", "outing"],
      evidence_status: ["candidate", "confirmed"],
      family_request_status: ["pending", "delivered", "answered", "expired"],
      job_kind: ["ingest"],
      message_modality: ["text", "voice"],
      message_role: ["user", "assistant", "system"],
      opportunity_status: [
        "proposed",
        "drafted",
        "offered",
        "approved",
        "consumed",
        "declined",
        "expired",
      ],
      signal_status: ["detected", "materialized", "suppressed"],
      signal_type: [
        "cadence_gap",
        "user_asserted_absence",
        "self_reported_wellbeing",
      ],
      time_precision: ["exact", "day", "week", "unknown"],
    },
  },
} as const
