import { useState, useEffect } from "react";

/**
 * A hook that implements Leader Election across browser tabs/windows using BroadcastChannel.
 * Only one instance (tab/window) will be the "leader" at any given time.
 * If the leader tab is closed, another tab will automatically become the new leader.
 */
export function useLeaderElection(channelName = "flashkit-leader-election") {
  const [isLeader, setIsLeader] = useState<boolean>(false);

  useEffect(() => {
    const channel = new BroadcastChannel(channelName);
    const id = Math.random().toString(36).substring(2, 11);
    let heartbeatInterval: number;
    let checkLeaderTimeout: number;
    let amILeader = false;

    // Listen for messages from other tabs
    channel.onmessage = (event) => {
      const { type } = event.data;
      if (type === "HEARTBEAT") {
        // We received a heartbeat from a leader.
        // We are definitely not the leader.
        if (amILeader) {
          // Conflict resolution: if we thought we were leader, step down
          amILeader = false;
          setIsLeader(false);
          clearInterval(heartbeatInterval);
        }
        
        // Reset our timeout that checks if the leader died
        clearTimeout(checkLeaderTimeout);
        startFollowerTimer();
      } else if (type === "NEW_LEADER") {
        // Someone else just became the leader
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
      // If we don't hear a heartbeat for 2.5 seconds, assume leader is dead
      // Add a small random jitter to prevent multiple followers from electing themselves at the exact same millisecond
      const timeoutDuration = 2500 + Math.random() * 500;
      checkLeaderTimeout = window.setTimeout(() => {
        if (!amILeader) {
          assumeLeadership();
        }
      }, timeoutDuration);
    };

    // When we first load, wait a short moment to see if there's an existing leader.
    // If we hear nothing, we become the leader.
    const initialWaitDuration = 500 + Math.random() * 500;
    checkLeaderTimeout = window.setTimeout(() => {
      assumeLeadership();
    }, initialWaitDuration);

    return () => {
      channel.close();
      clearInterval(heartbeatInterval);
      clearTimeout(checkLeaderTimeout);
    };
  }, [channelName]);

  return isLeader;
}
