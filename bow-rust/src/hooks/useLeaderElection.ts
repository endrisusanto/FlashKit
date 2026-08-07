import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * A hook that implements Leader Election across browser tabs/windows using BroadcastChannel.
 * Also coordinates with the Rust backend to ensure only one OS process is the leader.
 */
export function useLeaderElection(channelName = "flashkit-leader-election") {
  const [isLeader, setIsLeader] = useState<boolean>(false);
  const [isBackendLeader, setIsBackendLeader] = useState<boolean>(true);

  // 1. Determine if our backend is the leader
  useEffect(() => {
    if (!(window as any).__TAURI_INTERNALS__) {
      setIsBackendLeader(true);
      return;
    }

    const checkBackendLeader = () => {
      invoke<boolean>("is_bridge_leader")
        .then(res => setIsBackendLeader(res))
        .catch(() => setIsBackendLeader(false));
    };

    checkBackendLeader();
    const interval = setInterval(checkBackendLeader, 2000);
    return () => clearInterval(interval);
  }, []);

  // 2. Tab election (only if we are the backend leader)
  useEffect(() => {
    if (!isBackendLeader) {
      setIsLeader(false);
      return;
    }

    const channel = new BroadcastChannel(channelName);
    const id = Math.random().toString(36).substring(2, 11);
    let heartbeatInterval: number;
    let checkLeaderTimeout: number;
    let amILeader = false;

    // Listen for messages from other tabs
    channel.onmessage = (event) => {
      const { type } = event.data;
      if (type === "HEARTBEAT") {
        if (amILeader) {
          amILeader = false;
          setIsLeader(false);
          clearInterval(heartbeatInterval);
        }
        clearTimeout(checkLeaderTimeout);
        startFollowerTimer();
      } else if (type === "NEW_LEADER") {
        if (amILeader) {
          amILeader = false;
          setIsLeader(false);
          clearInterval(heartbeatInterval);
        }
        clearTimeout(checkLeaderTimeout);
        startFollowerTimer();
      }
    };

    const assumeLeadership = () => {
      amILeader = true;
      setIsLeader(true);
      channel.postMessage({ type: "NEW_LEADER", id });

      // Send regular heartbeats
      heartbeatInterval = window.setInterval(() => {
        channel.postMessage({ type: "HEARTBEAT", id });
      }, 1000); // 1-second heartbeat
    };

    const startFollowerTimer = () => {
      const timeoutDuration = 2500 + Math.random() * 500;
      checkLeaderTimeout = window.setTimeout(() => {
        if (!amILeader) {
          assumeLeadership();
        }
      }, timeoutDuration);
    };

    const initialWaitDuration = 500 + Math.random() * 500;
    checkLeaderTimeout = window.setTimeout(() => {
      assumeLeadership();
    }, initialWaitDuration);

    return () => {
      channel.close();
      clearInterval(heartbeatInterval);
      clearTimeout(checkLeaderTimeout);
    };
  }, [channelName, isBackendLeader]);

  return isLeader;
}
