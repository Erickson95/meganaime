import { useState, useEffect } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { getDoc, setDoc, doc } from "firebase/firestore";
import { auth, db, OperationType, handleFirestoreError } from "../lib/firebase";
import { User, Profile, isUserAdmin, setDynamicAdmins } from "../types";
import { safeLocalStorage } from "../utils/safeStorage";

export function useAuth() {
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    try {
      const cached = safeLocalStorage.getItem("megaAnime_user");
      return cached ? JSON.parse(cached) : null;
    } catch (e) {
      return null;
    }
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Sincronizar roles de administrador dinámicos desde el backend
    fetch("/api/admin/roles")
      .then(res => res.json())
      .then(roles => {
        if (Array.isArray(roles)) {
          setDynamicAdmins(roles);
          safeLocalStorage.setItem("megaAnime_dynamic_admins", JSON.stringify(roles));
        }
      })
      .catch(() => {});

    // Safety fallback: Never block the UI on loading screen
    const safetyTimer = setTimeout(() => {
      setLoading(false);
    }, 1000);

    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      if (fbUser) {
        try {
          const userDocRef = doc(db, "users", fbUser.uid);
          let userDoc: any = null;

          try {
            userDoc = await Promise.race([
              getDoc(userDocRef),
              new Promise((_, reject) => setTimeout(() => reject(new Error("firestore_timeout")), 2500))
            ]);
          } catch (e) {
            console.warn("Firestore getDoc timeout/warning, building fallback:", e);
          }
          
          let userData: any;
          const isAdminUser = isUserAdmin(fbUser.email);
          
          if (userDoc && typeof userDoc.exists === "function" && userDoc.exists()) {
            userData = userDoc.data();
            
            // Check and initialize profiles
            let profilesChanged = false;
            if (!userData.profiles || userData.profiles.length === 0) {
              userData.profiles = [
                {
                  id: "default",
                  name: userData.username || fbUser.displayName || "Principal",
                  avatarUrl: "https://s4.anilist.co/file/anilistcdn/character/large/b127691-9zqh1xpIubn7.png",
                  favorites: userData.favorites || [],
                  history: userData.history || [],
                  isChild: false
                }
              ];
              profilesChanged = true;
            }
            if (!userData.activeProfileId) {
              userData.activeProfileId = "default";
              profilesChanged = true;
            }

            const updates: any = {
              lastActive: new Date().toISOString(),
              isAdmin: isAdminUser
            };
            if (profilesChanged) {
              updates.profiles = userData.profiles;
              updates.activeProfileId = userData.activeProfileId;
            }

            setDoc(userDocRef, updates, { merge: true }).catch(() => {});
            userData.lastActive = new Date().toISOString();
            userData.isAdmin = isAdminUser;
          } else {
            const defaultProfile = {
              id: "default",
              name: fbUser.displayName || fbUser.email?.split("@")[0] || "Usuario",
              avatarUrl: "https://s4.anilist.co/file/anilistcdn/character/large/b127691-9zqh1xpIubn7.png",
              favorites: [],
              history: [],
              isChild: false
            };
            userData = {
              id: fbUser.uid,
              username: fbUser.displayName || fbUser.email?.split("@")[0] || "Usuario",
              email: fbUser.email?.toLowerCase() || "",
              favorites: [],
              history: [],
              profiles: [defaultProfile],
              activeProfileId: "default",
              isAdmin: isAdminUser,
              lastActive: new Date().toISOString(),
              createdAt: new Date().toISOString()
            };
            setDoc(userDocRef, userData, { merge: true }).catch(() => {});
          }
          
          setCurrentUser(userData as User);
          try { safeLocalStorage.setItem("megaAnime_user", JSON.stringify(userData)); } catch (e) {}
        } catch (error) {
          console.error("Firestore loading failed on auth state change:", error);
          const cachedUser = safeLocalStorage.getItem("megaAnime_user");
          if (cachedUser) {
            try {
              setCurrentUser(JSON.parse(cachedUser));
            } catch (e) {
              setCurrentUser(null);
            }
          } else {
            setCurrentUser(null);
          }
        }
      } else {
        setCurrentUser(null);
        try { safeLocalStorage.removeItem("megaAnime_user"); } catch (e) {}
      }
      clearTimeout(safetyTimer);
      setLoading(false);
    });

    return () => {
      clearTimeout(safetyTimer);
      unsubscribe();
    };
  }, []);

  const switchProfile = async (profileId: string) => {
    if (!currentUser) return;
    const updatedUser = { ...currentUser, activeProfileId: profileId };
    setCurrentUser(updatedUser);
    try { safeLocalStorage.setItem("megaAnime_user", JSON.stringify(updatedUser)); } catch (e) {}

    try {
      const userDocRef = doc(db, "users", currentUser.id);
      await setDoc(userDocRef, { activeProfileId: profileId }, { merge: true });
    } catch (error) {
      console.warn("Firestore sync failed for switchProfile:", error);
    }
  };

  const createProfile = async (name: string, avatarUrl: string, isChild: boolean = false) => {
    if (!currentUser) return;
    const newProfile: Profile = {
      id: "profile_" + Date.now(),
      name,
      avatarUrl,
      favorites: [],
      history: [],
      isChild
    };
    
    const currentProfiles = currentUser.profiles || [];
    const updatedProfiles = [...currentProfiles, newProfile];
    
    const updatedUser = { ...currentUser, profiles: updatedProfiles };
    setCurrentUser(updatedUser);
    try { safeLocalStorage.setItem("megaAnime_user", JSON.stringify(updatedUser)); } catch(e) {}

    try {
      const userDocRef = doc(db, "users", currentUser.id);
      await setDoc(userDocRef, { profiles: updatedProfiles }, { merge: true });
    } catch (error) {
      console.warn("Firestore sync failed for createProfile:", error);
    }
  };

  const updateProfile = async (profileId: string, name: string, avatarUrl: string, isChild: boolean = false) => {
    if (!currentUser) return;
    const currentProfiles = currentUser.profiles || [];
    const updatedProfiles = currentProfiles.map(p => {
      if (p.id === profileId) {
        return { ...p, name, avatarUrl, isChild };
      }
      return p;
    });
    
    const updatedUser = { ...currentUser, profiles: updatedProfiles };
    setCurrentUser(updatedUser);
    try { safeLocalStorage.setItem("megaAnime_user", JSON.stringify(updatedUser)); } catch(e) {}

    try {
      const userDocRef = doc(db, "users", currentUser.id);
      await setDoc(userDocRef, { profiles: updatedProfiles }, { merge: true });
    } catch (error) {
      console.warn("Firestore sync failed for updateProfile:", error);
    }
  };

  const deleteProfile = async (profileId: string) => {
    if (!currentUser || profileId === "default") return;
    const currentProfiles = currentUser.profiles || [];
    const updatedProfiles = currentProfiles.filter(p => p.id !== profileId);
    
    // If the deleted profile was active, switch active profile back to "default"
    let newActiveId = currentUser.activeProfileId;
    if (newActiveId === profileId) {
      newActiveId = "default";
    }
    
    const updatedUser = { 
      ...currentUser, 
      profiles: updatedProfiles,
      activeProfileId: newActiveId
    };
    setCurrentUser(updatedUser);
    try { safeLocalStorage.setItem("megaAnime_user", JSON.stringify(updatedUser)); } catch(e) {}

    try {
      const userDocRef = doc(db, "users", currentUser.id);
      await setDoc(userDocRef, { 
        profiles: updatedProfiles,
        activeProfileId: newActiveId
      }, { merge: true });
    } catch (error) {
      console.warn("Firestore sync failed for deleteProfile:", error);
    }
  };

  return { currentUser, setCurrentUser, loading, switchProfile, createProfile, updateProfile, deleteProfile };
}
