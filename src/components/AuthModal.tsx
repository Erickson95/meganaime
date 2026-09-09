import React, { useState, useRef, useEffect } from "react";
import { X, Mail, Lock, User, Sparkles, AlertCircle, Play, ShieldCheck, RotateCcw, ArrowLeft } from "lucide-react";
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signInWithPopup, 
  GoogleAuthProvider,
  sendEmailVerification
} from "firebase/auth";
import { setDoc, getDoc, doc } from "firebase/firestore";
import { auth, db, OperationType, handleFirestoreError } from "../lib/firebase";
import { getApiUrl, isNativePlatform } from "../utils/apiConfig";
import { App as CapApp } from "@capacitor/app";
import { isUserAdmin } from "../types";

interface AuthModalProps {
  onClose?: () => void;
  onSuccess: (user: any) => void;
  isFullScreen?: boolean;
}

export default function AuthModal({ onClose, onSuccess, isFullScreen = false }: AuthModalProps) {
  const [isLogin, setIsLogin] = useState(true);
  const [step, setStep] = useState<"form" | "otp">("form");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [loading, setLoading] = useState(false);

  // 6-Digit OTP State
  const [otpDigits, setOtpDigits] = useState<string[]>(["", "", "", "", "", ""]);
  const [attemptsLeft, setAttemptsLeft] = useState<number>(3);
  const [countdown, setCountdown] = useState<number>(60);
  const [canResend, setCanResend] = useState<boolean>(false);
  const otpInputRefs = [
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null)
  ];

  // OTP Countdown timer
  useEffect(() => {
    let timer: any = null;
    if (step === "otp" && countdown > 0) {
      timer = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) {
            setCanResend(true);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [step, countdown]);

  const handleSendOtp = async (targetEmail: string) => {
    setErrorMsg("");
    setLoading(true);
    try {
      const res = await fetch(getApiUrl("/api/auth/send-otp"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetEmail,
          username: username.trim() || targetEmail.split("@")[0]
        })
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "No se pudo enviar el código de verificación.");
      }

      setStep("otp");
      setCountdown(60);
      setCanResend(false);
      setAttemptsLeft(3);
      setOtpDigits(["", "", "", "", "", ""]);
      setTimeout(() => otpInputRefs[0].current?.focus(), 100);
    } catch (err: any) {
      setErrorMsg(err.message || "Error al enviar el código a tu correo.");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyAndRegister = async (codeToVerify: string) => {
    if (codeToVerify.length !== 6) return;
    setErrorMsg("");
    setLoading(true);

    const cleanEmail = email.trim().toLowerCase();

    try {
      const res = await fetch(getApiUrl("/api/auth/verify-otp"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: cleanEmail,
          code: codeToVerify
        })
      });
      const data = await res.json();

      if (!res.ok) {
        if (data.attemptsLeft !== undefined) {
          setAttemptsLeft(data.attemptsLeft);
        }
        if (data.maxAttemptsExceeded || data.expired) {
          setTimeout(() => {
            setStep("form");
            setOtpDigits(["", "", "", "", "", ""]);
          }, 2500);
        }
        throw new Error(data.error || "Código incorrecto.");
      }

      // Step 2 -> Create actual Firebase user account
      const userCredential = await createUserWithEmailAndPassword(auth, cleanEmail, password);
      const fbUser = userCredential.user;
      const isAdminUser = isUserAdmin(cleanEmail);

      const defaultProfile = {
        id: "default",
        name: username.trim() || cleanEmail.split("@")[0],
        avatarUrl: "https://s4.anilist.co/file/anilistcdn/character/large/b127691-9zqh1xpIubn7.png",
        favorites: [],
        history: [],
        isChild: false
      };

      const userData = {
        id: fbUser.uid,
        username: username.trim() || cleanEmail.split("@")[0],
        email: cleanEmail,
        favorites: [],
        history: [],
        profiles: [defaultProfile],
        activeProfileId: "default",
        isAdmin: isAdminUser,
        lastActive: new Date().toISOString(),
        createdAt: new Date().toISOString()
      };

      try {
        await setDoc(doc(db, "users", fbUser.uid), userData);
      } catch (dbErr) {
        handleFirestoreError(dbErr, OperationType.CREATE, `users/${fbUser.uid}`);
      }

      onSuccess(userData);
    } catch (err: any) {
      let msg = err.message || "Error al completar el registro.";
      if (err.code === "auth/email-already-in-use") {
        msg = "Este correo ya está registrado. Por favor inicia sesión.";
        setStep("form");
      }
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes("@")) {
      setErrorMsg("Introduce un correo electrónico válido");
      return;
    }

    if (isLogin) {
      if (!password) {
        setErrorMsg("Introduce tu contraseña");
        return;
      }

      setLoading(true);
      try {
        const userCredential = await Promise.race([
          signInWithEmailAndPassword(auth, cleanEmail, password),
          new Promise((_, reject) => setTimeout(() => reject(new Error("auth_timeout")), 10000))
        ]) as any;

        const fbUser = userCredential.user;
        const isAdminUser = isUserAdmin(cleanEmail);

        let userData: any = null;
        try {
          const userDoc = await Promise.race([
            getDoc(doc(db, "users", fbUser.uid)),
            new Promise((_, reject) => setTimeout(() => reject(new Error("doc_timeout")), 2500))
          ]) as any;

          if (userDoc && typeof userDoc.exists === "function" && userDoc.exists()) {
            userData = userDoc.data();
            userData.isAdmin = isAdminUser;
          }
        } catch (dbErr) {
          console.warn("Firestore getDoc timeout/warning on login:", dbErr);
        }

        if (!userData) {
          const defaultProfile = {
            id: "default",
            name: fbUser.displayName || email.split("@")[0] || "Usuario",
            avatarUrl: "https://s4.anilist.co/file/anilistcdn/character/large/b127691-9zqh1xpIubn7.png",
            favorites: [],
            history: [],
            isChild: false
          };
          userData = {
            id: fbUser.uid,
            username: fbUser.displayName || email.split("@")[0] || "Usuario",
            email: cleanEmail,
            favorites: [],
            history: [],
            profiles: [defaultProfile],
            activeProfileId: "default",
            isAdmin: isAdminUser,
            createdAt: new Date().toISOString()
          };
          setDoc(doc(db, "users", fbUser.uid), userData, { merge: true }).catch(() => {});
        }

        onSuccess(userData);
      } catch (err: any) {
        let msg = "Ocurrió un error en la autenticación.";
        if (err.message === "auth_timeout") {
          msg = "Tiempo de espera agotado. Verifica tu conexión a internet.";
        } else if (err.code === "auth/wrong-password" || err.code === "auth/user-not-found" || err.code === "auth/invalid-credential") {
          msg = "Correo electrónico o contraseña incorrectos.";
        } else if (err.code === "auth/too-many-requests") {
          msg = "Demasiados intentos fallidos. Por favor espera unos minutos.";
        } else if (err.message) {
          msg = err.message;
        }
        setErrorMsg(msg);
      } finally {
        setLoading(false);
      }
    } else {
      // Registration Step
      if (username.trim().length < 2) {
        setErrorMsg("El nombre de usuario debe tener al menos 2 caracteres");
        return;
      }
      if (password.length < 6) {
        setErrorMsg("La contraseña debe tener al menos 6 caracteres");
        return;
      }

      setLoading(true);
      try {
        const userCredential = await Promise.race([
          createUserWithEmailAndPassword(auth, cleanEmail, password),
          new Promise((_, reject) => setTimeout(() => reject(new Error("auth_timeout")), 10000))
        ]) as any;

        const fbUser = userCredential.user;
        const isAdminUser = isUserAdmin(cleanEmail);

        // Send official verification email via Firebase Auth
        try {
          await sendEmailVerification(fbUser);
        } catch (mailErr) {
          console.warn("Could not trigger email verification:", mailErr);
        }

        const defaultProfile = {
          id: "default",
          name: username.trim() || cleanEmail.split("@")[0],
          avatarUrl: "https://s4.anilist.co/file/anilistcdn/character/large/b127691-9zqh1xpIubn7.png",
          favorites: [],
          history: [],
          isChild: false
        };

        const userData = {
          id: fbUser.uid,
          username: username.trim() || cleanEmail.split("@")[0],
          email: cleanEmail,
          favorites: [],
          history: [],
          profiles: [defaultProfile],
          activeProfileId: "default",
          isAdmin: isAdminUser,
          lastActive: new Date().toISOString(),
          createdAt: new Date().toISOString()
        };

        setDoc(doc(db, "users", fbUser.uid), userData, { merge: true }).catch(() => {});

        onSuccess(userData);
      } catch (err: any) {
        let msg = "Error al completar el registro.";
        if (err.message === "auth_timeout") {
          msg = "Tiempo de espera agotado. Verifica tu conexión a internet.";
        } else if (err.code === "auth/email-already-in-use") {
          msg = "Este correo ya está registrado. Por favor inicia sesión.";
        } else if (err.code === "auth/weak-password") {
          msg = "La contraseña debe tener al menos 6 caracteres.";
        } else if (err.code === "auth/invalid-email") {
          msg = "El formato de correo electrónico no es válido.";
        } else if (err.message) {
          msg = err.message;
        }
        setErrorMsg(msg);
      } finally {
        setLoading(false);
      }
    }
  };

  const handleOtpChange = (index: number, val: string) => {
    const cleanVal = val.replace(/[^0-9]/g, "");
    if (!cleanVal && val !== "") return;

    const newDigits = [...otpDigits];
    newDigits[index] = cleanVal.slice(-1);
    setOtpDigits(newDigits);

    if (cleanVal && index < 5) {
      otpInputRefs[index + 1].current?.focus();
    }

    const fullCode = newDigits.join("");
    if (fullCode.length === 6) {
      handleVerifyAndRegister(fullCode);
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !otpDigits[index] && index > 0) {
      otpInputRefs[index - 1].current?.focus();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/[^0-9]/g, "").slice(0, 6);
    if (pasted.length > 0) {
      const newDigits = ["", "", "", "", "", ""];
      for (let i = 0; i < pasted.length; i++) {
        newDigits[i] = pasted[i];
      }
      setOtpDigits(newDigits);
      if (pasted.length === 6) {
        handleVerifyAndRegister(pasted);
      } else {
        const nextIdx = Math.min(pasted.length, 5);
        otpInputRefs[nextIdx].current?.focus();
      }
    }
  };

  const handleGoogleLogin = async () => {
    setErrorMsg("");
    setLoading(true);

    // Native iOS & Android: Use In-App Safari OAuth with return scheme net.megaanime.app://
    if (isNativePlatform()) {
      try {
        const stateId = Math.random().toString(36).slice(2) + Date.now().toString(36);
        let completed = false;

        const handleDeepLinkUrl = async (rawUrl: string) => {
          if (!rawUrl || (!rawUrl.includes("auth-callback") && !rawUrl.includes("megaanime") && !rawUrl.includes("net.megaanime.app"))) return;
          try {
            const getQueryParam = (k: string) => {
              const m = rawUrl.match(new RegExp(`[?&]${k}=([^&]*)`));
              return m ? decodeURIComponent(m[1]) : null;
            };

            const uid = getQueryParam("uid");
            const emailParam = getQueryParam("email");
            const nameParam = getQueryParam("name");
            const photoParam = getQueryParam("photo");

            if (uid && emailParam) {
              completed = true;
              const cleanEmail = emailParam.toLowerCase().trim();
              const isAdminUser = isUserAdmin(cleanEmail);

              let userData: any;
              try {
                const userDoc = await getDoc(doc(db, "users", uid));
                if (userDoc.exists()) {
                  userData = userDoc.data();
                  userData.isAdmin = isAdminUser;
                } else {
                  userData = {
                    id: uid,
                    username: nameParam || cleanEmail.split("@")[0] || "Usuario Google",
                    email: cleanEmail,
                    avatarUrl: photoParam || "https://s4.anilist.co/file/anilistcdn/character/large/b127691-9zqh1xpIubn7.png",
                    favorites: [],
                    history: [],
                    isAdmin: isAdminUser,
                    createdAt: new Date().toISOString()
                  };
                  await setDoc(doc(db, "users", uid), userData);
                }
              } catch (dbErr) {
                console.warn("Firestore error on OAuth callback:", dbErr);
              }

              onSuccess(userData);
            }
          } catch (parseErr) {
            console.error("Error parsing auth callback URL:", parseErr);
          } finally {
            setLoading(false);
          }
        };

        // 1. Global iOS scheme handler
        (window as any).handleOpenURL = (url: string) => {
          handleDeepLinkUrl(url);
        };

        // 2. Window message handler for popups / web views
        const messageHandler = (e: MessageEvent) => {
          if (typeof e.data === "string" && (e.data.includes("auth-callback") || e.data.includes("megaanime") || e.data.includes("net.megaanime.app"))) {
            handleDeepLinkUrl(e.data);
          }
        };
        window.addEventListener("message", messageHandler, { once: true });

        // 3. Safe Capacitor App Listener
        try {
          if (CapApp && typeof CapApp.addListener === "function") {
            CapApp.addListener("appUrlOpen", (data: any) => {
              if (data && data.url) handleDeepLinkUrl(data.url);
            }).catch(() => {});
          }
        } catch (e) {}

        // Safety timeout in case user closes the external browser
        setTimeout(() => {
          if (!completed) {
            setLoading(false);
          }
        }, 45000);

        const targetAuthUrl = `https://megaanime-1c250.firebaseapp.com/google-auth.html?state=${encodeURIComponent(stateId)}`;
        window.open(targetAuthUrl, "_blank");
      } catch (nativeErr: any) {
        console.error("Native Google OAuth Error:", nativeErr);
        setErrorMsg("No se pudo iniciar el navegador para Google. Puedes ingresar con tu correo.");
        setLoading(false);
      }
      return;
    }

    // Web Platform: Standard popup flow
    try {
      const provider = new GoogleAuthProvider();
      const userCredential = await Promise.race([
        signInWithPopup(auth, provider),
        new Promise((_, reject) => setTimeout(() => reject(new Error("popup_timeout")), 10000))
      ]) as any;
      const fbUser = userCredential.user;
      const cleanEmail = fbUser.email?.toLowerCase().trim() || "";
      const isAdminUser = isUserAdmin(cleanEmail);

      let userData: any;
      try {
        const userDoc = await getDoc(doc(db, "users", fbUser.uid));
        if (userDoc.exists()) {
          userData = userDoc.data();
          userData.isAdmin = isAdminUser;
        } else {
          userData = {
            id: fbUser.uid,
            username: fbUser.displayName || cleanEmail.split("@")[0] || "Usuario Google",
            email: cleanEmail,
            favorites: [],
            history: [],
            isAdmin: isAdminUser,
            createdAt: new Date().toISOString()
          };
          await setDoc(doc(db, "users", fbUser.uid), userData);
        }
      } catch (dbErr) {
        handleFirestoreError(dbErr, OperationType.GET, `users/${fbUser.uid}`);
      }

      onSuccess(userData);
    } catch (err: any) {
      let msg = err.message || "Error al iniciar sesión con Google.";
      if (err.code === "auth/popup-closed-by-user") {
        msg = "La ventana de inicio de sesión fue cerrada.";
      }
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  };

  const formatTimer = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}`;
  };

  const cardContent = (
    <div className={`relative w-full max-w-md rounded-3xl border border-white/10 ${isFullScreen ? 'bg-neutral-900/40 backdrop-blur-xl' : 'bg-neutral-950'} p-6 sm:p-8 text-neutral-100 shadow-2xl overflow-hidden`}>
      {/* Glow Effects */}
      <div className="absolute -top-16 -left-16 h-36 w-36 rounded-full bg-rose-500/10 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-16 -right-16 h-36 w-36 rounded-full bg-rose-600/10 blur-3xl pointer-events-none" />

      {/* Header */}
      <div className="flex items-center justify-between mb-6 relative">
        <div className="flex items-center space-x-2">
          {step === "otp" ? (
            <ShieldCheck className="h-5 w-5 text-rose-500" />
          ) : (
            <Sparkles className="h-5 w-5 text-rose-500" />
          )}
          <h2 className="text-lg font-black tracking-tight text-white">
            {step === "otp"
              ? "Verificación de Código OTP"
              : isLogin
              ? "Inicia Sesión en megaAnime"
              : "Únete a megaAnime"}
          </h2>
        </div>
        {!isFullScreen && onClose && (
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/5 text-neutral-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        )}
      </div>

      {/* Error Alert */}
      {errorMsg && (
        <div className="mb-4 flex flex-col gap-2.5 rounded-xl bg-red-500/10 border border-red-500/20 p-3.5 text-xs text-red-400 animate-fade-in">
          <div className="flex items-start space-x-2">
            <AlertCircle className="h-4.5 w-4.5 flex-shrink-0 mt-0.5" />
            <span className="leading-relaxed font-semibold">{errorMsg}</span>
          </div>
        </div>
      )}

      {/* STEP 2: 6-DIGIT OTP VERIFICATION SCREEN */}
      {step === "otp" ? (
        <div className="space-y-6 relative animate-fade-in">
          <div className="space-y-2 text-center">
            <p className="text-xs text-neutral-300 leading-relaxed">
              Hemos enviado un código de seguridad de <strong className="text-white">6 dígitos</strong> a:
            </p>
            <div className="inline-block px-3 py-1 bg-white/5 border border-white/10 rounded-full text-xs font-bold text-rose-400 font-mono">
              {email}
            </div>
          </div>

          {/* 6 Individual Numeric Input Boxes */}
          <div className="flex justify-between gap-2 py-2">
            {otpDigits.map((digit, idx) => (
              <input
                key={idx}
                ref={otpInputRefs[idx]}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(e) => handleOtpChange(idx, e.target.value)}
                onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                onPaste={idx === 0 ? handleOtpPaste : undefined}
                className={`h-12 w-11 sm:h-14 sm:w-12 text-center text-xl font-black text-white bg-black/60 border rounded-xl focus:border-rose-500 focus:bg-rose-500/10 focus:outline-none focus:ring-2 focus:ring-rose-500/30 transition-all font-mono ${
                  errorMsg ? "border-rose-500/60 bg-rose-500/5" : "border-white/10"
                }`}
              />
            ))}
          </div>

          {/* Attempts counter & timer */}
          <div className="flex items-center justify-between text-xs px-1 font-semibold">
            <span className={`flex items-center gap-1.5 ${attemptsLeft <= 1 ? 'text-rose-400 font-black' : 'text-neutral-400'}`}>
              <span>Intentos restantes:</span>
              <span className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 font-bold">{attemptsLeft} / 3</span>
            </span>
            <span className="text-neutral-400 font-mono">
              Expira en: <strong className="text-white">{formatTimer(countdown)}</strong>
            </span>
          </div>

          {/* Action buttons */}
          <div className="space-y-3 pt-2">
            <button
              onClick={() => handleVerifyAndRegister(otpDigits.join("").trim())}
              disabled={loading || otpDigits.join("").length < 6}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-rose-600 to-rose-500 text-sm font-bold text-white shadow-lg shadow-rose-600/15 hover:from-rose-500 hover:to-rose-400 active:scale-95 disabled:scale-100 disabled:opacity-50 transition cursor-pointer flex items-center justify-center space-x-2"
            >
              {loading ? (
                <>
                  <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Verificando...</span>
                </>
              ) : (
                <span>Verificar y Completar Registro</span>
              )}
            </button>

            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => {
                  setStep("form");
                  setErrorMsg("");
                }}
                className="flex items-center space-x-1 text-xs font-bold text-neutral-400 hover:text-white transition cursor-pointer"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>Modificar Correo</span>
              </button>

              <button
                onClick={() => handleSendOtp(email.trim().toLowerCase())}
                disabled={loading || !canResend}
                className="flex items-center space-x-1 text-xs font-bold text-rose-400 hover:text-rose-300 disabled:opacity-40 transition cursor-pointer"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Reenviar Código {countdown > 0 ? `(${countdown}s)` : ""}</span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* STEP 1: FORM INPUT SCREEN */
        <form onSubmit={handleSubmit} className="space-y-4 relative">
          {!isLogin && (
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-400">Nombre de Usuario</label>
              <div className="relative">
                <User className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-500" />
                <input
                  type="text"
                  placeholder="Tu alias favorito"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full rounded-xl border border-white/5 bg-white/5 py-2.5 pr-4 pl-10 text-sm text-white placeholder-neutral-500 focus:border-rose-500/40 focus:bg-white/10 focus:outline-none focus:ring-1 focus:ring-rose-500/40 transition-all"
                  required={!isLogin}
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-neutral-400">Correo Electrónico</label>
            <div className="relative">
              <Mail className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-500" />
              <input
                type="email"
                placeholder="ejemplo@correo.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-xl border border-white/5 bg-white/5 py-2.5 pr-4 pl-10 text-sm text-white placeholder-neutral-500 focus:border-rose-500/40 focus:bg-white/10 focus:outline-none focus:ring-1 focus:ring-rose-500/40 transition-all"
                required
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-neutral-400">Contraseña</label>
            <div className="relative">
              <Lock className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-500" />
              <input
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl border border-white/5 bg-white/5 py-2.5 pr-4 pl-10 text-sm text-white placeholder-neutral-500 focus:border-rose-500/40 focus:bg-white/10 focus:outline-none focus:ring-1 focus:ring-rose-500/40 transition-all"
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-rose-600 to-rose-500 text-sm font-bold text-white shadow-lg shadow-rose-600/15 hover:from-rose-500 hover:to-rose-400 active:scale-95 disabled:scale-100 disabled:opacity-50 transition cursor-pointer flex items-center justify-center space-x-2"
          >
            {loading ? (
              <>
                <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>{isLogin ? "Iniciando Sesión..." : "Creando Cuenta..."}</span>
              </>
            ) : isLogin ? (
              "Iniciar Sesión"
            ) : (
              "Crear Cuenta"
            )}
          </button>
        </form>
      )}

      {/* Divider & Google Login (Form step only) */}
      {step === "form" && (
        <>
          <div className="my-4 flex items-center justify-between text-neutral-600 text-[10px] uppercase font-bold tracking-wider relative">
            <div className="h-px bg-white/5 flex-grow" />
            <span className="px-3 text-neutral-500">O continúa con</span>
            <div className="h-px bg-white/5 flex-grow" />
          </div>

          <button
            onClick={handleGoogleLogin}
            disabled={loading}
            className="w-full py-2.5 border border-white/10 rounded-xl bg-white/5 hover:bg-white/10 text-xs font-bold text-neutral-200 transition flex items-center justify-center space-x-2 active:scale-95 disabled:scale-100 disabled:opacity-50 cursor-pointer relative"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/>
            </svg>
            <span>Google</span>
          </button>

          <div className="mt-5 border-t border-white/5 pt-4 text-center text-xs text-neutral-400 relative">
            <span>{isLogin ? "¿Nuevo en megaAnime?" : "¿Ya tienes una cuenta?"} </span>
            <button
              type="button"
              onClick={() => {
                setIsLogin(!isLogin);
                setStep("form");
                setErrorMsg("");
              }}
              className="font-bold text-rose-400 hover:text-rose-300 transition cursor-pointer"
            >
              {isLogin ? "Crea una cuenta aquí" : "Inicia sesión aquí"}
            </button>
          </div>
        </>
      )}
    </div>
  );

  if (isFullScreen) {
    return (
      <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center p-4 relative overflow-hidden bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(244,63,94,0.15),rgba(255,255,255,0))]">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,#000_70%,transparent_100%)] pointer-events-none" />
        
        <div className="flex flex-col items-center mb-8 space-y-2.5 relative z-10 scale-105 sm:scale-110">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-tr from-rose-600 via-orange-500 to-amber-400 shadow-xl shadow-rose-500/30">
            <Play className="h-7 w-7 fill-white text-white ml-0.5" />
          </div>
          <span className="bg-gradient-to-r from-white via-neutral-100 to-rose-400 bg-clip-text text-3xl font-black tracking-tight text-transparent">
            mega<span className="text-rose-500">Anime</span>
          </span>
          <p className="text-xs text-neutral-400 max-w-xs text-center font-medium">El portal definitivo para anime, películas y mangas en alta calidad</p>
        </div>

        {cardContent}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      {cardContent}
    </div>
  );
}
