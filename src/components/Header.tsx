import React, { useState, useRef, useEffect } from "react";
import { Play, Search, Heart, LogIn, LogOut, User, Compass, Tv, Film, BookOpen, ChevronDown, Plus, Download, KeyRound } from "lucide-react";
import { User as UserType } from "../types";

interface HeaderProps {
  currentUser: UserType | null;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onOpenAuth: () => void;
  onLogout: () => void;
  onOpenProfiles?: (initialTab?: "profiles" | "security" | "preferences") => void;
  onSwitchProfile?: (id: string) => void;
}

export default function Header({
  currentUser,
  activeTab,
  setActiveTab,
  onOpenAuth,
  onLogout,
  onOpenProfiles,
  onSwitchProfile
}: HeaderProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeProfile = currentUser?.profiles?.find(p => p.id === currentUser.activeProfileId);
  const avatarUrl = activeProfile?.avatarUrl || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=150&h=150&fit=crop";
  const profileName = activeProfile?.name || currentUser?.username || "Usuario";
  const otherProfiles = currentUser?.profiles?.filter(p => p.id !== currentUser.activeProfileId) || [];
  
  // Primary / Main profile check (default profile or first profile in list)
  const isMainProfile = !currentUser?.activeProfileId || 
    currentUser.activeProfileId === "default" || 
    (currentUser?.profiles && currentUser.profiles.length > 0 && currentUser.activeProfileId === currentUser.profiles[0].id);

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleQuickSwitch = (id: string) => {
    if (onSwitchProfile) {
      onSwitchProfile(id);
    }
    setShowDropdown(false);
  };

  const handleOpenProfilesClick = (tab: "profiles" | "security" | "preferences" = "profiles") => {
    if (onOpenProfiles) {
      onOpenProfiles(tab);
    }
    setShowDropdown(false);
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b border-white/5 bg-black/85 backdrop-blur-md pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Logo */}
        <div 
          onClick={() => setActiveTab("inicio")} 
          className="flex cursor-pointer items-center space-x-2 transition hover:opacity-90"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-pink-600 via-rose-500 to-pink-400 shadow-lg shadow-pink-500/30 border border-pink-400/20">
            <Play className="h-5 w-5 fill-black text-black ml-0.5" />
          </div>
          <span className="bg-gradient-to-r from-white via-neutral-100 to-rose-400 bg-clip-text text-xl font-black tracking-tight text-transparent">
            mega<span className="text-rose-500">Anime</span>
          </span>
        </div>

        {/* Desktop Navigation */}
        <nav className="hidden md:flex items-center space-x-1">
          <button
            onClick={() => setActiveTab("inicio")}
            className={`flex items-center space-x-1.5 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              activeTab === "inicio"
                ? "bg-rose-500/10 text-rose-400"
                : "text-neutral-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            <Tv className="h-4 w-4" />
            <span>Inicio</span>
          </button>

          <button
            onClick={() => setActiveTab("peliculas")}
            className={`flex items-center space-x-1.5 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              activeTab === "peliculas"
                ? "bg-rose-500/10 text-rose-400"
                : "text-neutral-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            <Film className="h-4 w-4" />
            <span>Películas</span>
          </button>
          <button
            onClick={() => setActiveTab("mangas")}
            className={`flex items-center space-x-1.5 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              activeTab === "mangas"
                ? "bg-rose-500/10 text-rose-400"
                : "text-neutral-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            <BookOpen className="h-4 w-4" />
            <span>Mangas</span>
          </button>
          <button
            onClick={() => setActiveTab("buscar")}
            className={`flex items-center space-x-1.5 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              activeTab === "buscar"
                ? "bg-rose-500/10 text-rose-400"
                : "text-neutral-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            <Search className="h-4 w-4" />
            <span>Buscar</span>
          </button>
          <button
            onClick={() => setActiveTab("categorias")}
            className={`flex items-center space-x-1.5 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              activeTab === "categorias"
                ? "bg-rose-500/10 text-rose-400"
                : "text-neutral-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            <Compass className="h-4 w-4" />
            <span>Categorías</span>
          </button>
          <button
            onClick={() => {
              if (!currentUser) {
                onOpenAuth();
              } else {
                setActiveTab("favoritos");
              }
            }}
            className={`flex items-center space-x-1.5 px-4 py-2 rounded-xl text-sm font-medium transition-all relative ${
              activeTab === "favoritos"
                ? "bg-rose-500/10 text-rose-400"
                : "text-neutral-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            <Heart className={`h-4 w-4 ${currentUser && currentUser.favorites.length > 0 ? "fill-rose-500 text-rose-500" : ""}`} />
            <span>Mis Favoritos</span>
            {currentUser && currentUser.favorites.length > 0 && (
              <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold text-white">
                {currentUser.favorites.length}
              </span>
            )}
          </button>
          
          <button
            onClick={() => {
              if (!currentUser) {
                onOpenAuth();
              } else {
                setActiveTab("descargas");
              }
            }}
            className={`flex items-center space-x-1.5 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              activeTab === "descargas"
                ? "bg-rose-500/10 text-rose-400"
                : "text-neutral-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            <Download className="h-4 w-4" />
            <span>Descargas</span>
          </button>
        </nav>

        {/* User Account Controls */}
        <div className="flex items-center space-x-4">
          {((currentUser?.isAdmin && currentUser?.email?.toLowerCase().trim() === "baezcabrera.j.r@gmail.com") ||
            (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"))) && (
            <button
              onClick={() => setActiveTab("admin")}
              className={`hidden md:flex items-center space-x-1 px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                activeTab === "admin"
                  ? "bg-rose-500 text-white"
                  : "bg-white/5 text-neutral-400 hover:bg-white/10 hover:text-white"
              }`}
            >
              <Compass className="h-4 w-4" />
              <span>Admin Panel</span>
            </button>
          )}



          {currentUser ? (
            <div className="relative flex-shrink-0" ref={dropdownRef}>
              <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="flex items-center justify-center rounded-full hover:opacity-90 transition cursor-pointer p-0.5"
                title={profileName}
              >
                <div className="relative flex-shrink-0">
                  <img
                    src={avatarUrl}
                    alt={profileName}
                    className="h-11 w-11 sm:h-12 sm:w-12 rounded-full object-cover aspect-square flex-shrink-0 border-2 border-rose-500/60 shadow-lg hover:scale-105 transition duration-200"
                    referrerPolicy="no-referrer"
                  />
                  {activeProfile?.isChild && (
                    <div className="absolute -bottom-0.5 -right-0.5 bg-amber-500 text-black text-[9px] font-black rounded-full h-4.5 w-4.5 flex items-center justify-center border border-black shadow">
                      👶
                    </div>
                  )}
                </div>
              </button>

              {/* Crunchyroll-style Dropdown */}
              {showDropdown && (
                <div className="absolute right-0 mt-2 w-64 rounded-2xl bg-neutral-900 border border-white/5 p-4 shadow-2xl animate-in fade-in slide-in-from-top-3 duration-200">
                  <div className="flex items-center space-x-3 pb-3 border-b border-white/5">
                    <img src={avatarUrl} alt={profileName} className="h-10 w-10 rounded-xl object-cover" referrerPolicy="no-referrer" />
                    <div>
                      <p className="text-sm font-bold text-white">{profileName}</p>
                      <p className="text-xs text-neutral-400 truncate max-w-[150px]">{currentUser.email}</p>
                    </div>
                  </div>

                  {/* Switch Profile Section */}
                  {currentUser.profiles && currentUser.profiles.length > 1 && (
                    <div className="py-3 border-b border-white/5">
                      <p className="text-[10px] font-extrabold text-neutral-500 uppercase tracking-widest mb-2">Cambiar Perfil</p>
                      <div className="space-y-1.5 max-h-[140px] overflow-y-auto pr-1">
                        {otherProfiles.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => handleQuickSwitch(p.id)}
                            className="flex w-full items-center space-x-2.5 rounded-lg px-2 py-1.5 hover:bg-white/5 text-left text-xs font-semibold text-neutral-300 hover:text-white transition"
                          >
                            <img src={p.avatarUrl} alt={p.name} className="h-6 w-6 rounded-md object-cover" referrerPolicy="no-referrer" />
                            <span className="truncate flex-1">{p.name}</span>
                            {p.isChild && (
                              <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-amber-500/10 text-amber-400 font-bold">Kids</span>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Profile Commands */}
                  <div className="space-y-1 py-3 border-b border-white/5">
                    {isMainProfile && (
                      <button
                        onClick={() => handleOpenProfilesClick("security")}
                        className="flex w-full items-center space-x-2 rounded-lg px-2.5 py-2 text-xs font-bold text-neutral-300 hover:text-white hover:bg-white/5 transition cursor-pointer"
                      >
                        <KeyRound className="h-4 w-4 text-rose-500" />
                        <span>Cambiar Contraseña</span>
                      </button>
                    )}
                    <button
                      onClick={() => handleOpenProfilesClick("profiles")}
                      className="flex w-full items-center space-x-2 rounded-lg px-2.5 py-2 text-xs font-bold text-neutral-300 hover:text-white hover:bg-white/5 transition cursor-pointer"
                    >
                      <User className="h-4 w-4 text-neutral-400" />
                      <span>Administrar Perfiles</span>
                    </button>
                  </div>

                  {/* Logout */}
                  <button
                    onClick={() => {
                      setShowDropdown(false);
                      onLogout();
                    }}
                    className="flex w-full items-center space-x-2 rounded-lg px-2.5 py-2 text-xs font-bold text-neutral-400 hover:text-rose-400 hover:bg-rose-500/5 transition mt-2"
                  >
                    <LogOut className="h-4 w-4" />
                    <span>Cerrar Sesión</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={onOpenAuth}
              className="flex items-center space-x-2 rounded-xl bg-gradient-to-r from-rose-600 to-rose-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-rose-600/20 hover:from-rose-500 hover:to-rose-400 active:scale-95 transition"
            >
              <LogIn className="h-4 w-4" />
              <span>Entrar</span>
            </button>
          )}
        </div>
      </div>

      {/* Mobile Navigation Bar */}
      <div className="flex md:hidden border-t border-white/5 bg-black/90 py-1 justify-around text-xs">
        <button
          onClick={() => setActiveTab("inicio")}
          className={`flex flex-col items-center py-1.5 px-3 transition-colors ${
            activeTab === "inicio" ? "text-rose-400" : "text-neutral-500"
          }`}
        >
          <Tv className="h-5 w-5 mb-0.5" />
          <span>Inicio</span>
        </button>
        <button
          onClick={() => setActiveTab("peliculas")}
          className={`flex flex-col items-center py-1.5 px-3 transition-colors ${
            activeTab === "peliculas" ? "text-rose-400" : "text-neutral-500"
          }`}
        >
          <Film className="h-5 w-5 mb-0.5" />
          <span>Películas</span>
        </button>
        <button
          onClick={() => setActiveTab("mangas")}
          className={`flex flex-col items-center py-1.5 px-3 transition-colors ${
            activeTab === "mangas" ? "text-rose-400" : "text-neutral-500"
          }`}
        >
          <BookOpen className="h-5 w-5 mb-0.5" />
          <span>Mangas</span>
        </button>
        <button
          onClick={() => setActiveTab("buscar")}
          className={`flex flex-col items-center py-1.5 px-3 transition-colors ${
            activeTab === "buscar" ? "text-rose-400" : "text-neutral-500"
          }`}
        >
          <Search className="h-5 w-5 mb-0.5" />
          <span>Buscar</span>
        </button>
        <button
          onClick={() => setActiveTab("categorias")}
          className={`flex flex-col items-center py-1.5 px-3 transition-colors ${
            activeTab === "categorias" ? "text-rose-400" : "text-neutral-500"
          }`}
        >
          <Compass className="h-5 w-5 mb-0.5" />
          <span>Categorías</span>
        </button>
        <button
          onClick={() => {
            if (!currentUser) {
              onOpenAuth();
            } else {
              setActiveTab("favoritos");
            }
          }}
          className={`flex flex-col items-center py-1.5 px-3 relative transition-colors ${
            activeTab === "favoritos" ? "text-rose-400" : "text-neutral-500"
          }`}
        >
          <Heart className={`h-5 w-5 mb-0.5 ${currentUser && currentUser.favorites.length > 0 ? "fill-rose-500 text-rose-500" : ""}`} />
          <span>Favoritos</span>
          {currentUser && currentUser.favorites.length > 0 && (
            <span className="absolute top-1 right-3 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-rose-500 text-[9px] font-bold text-white">
              {currentUser.favorites.length}
            </span>
          )}
        </button>
        <button
          onClick={() => {
            if (!currentUser) {
              onOpenAuth();
            } else {
              setActiveTab("descargas");
            }
          }}
          className={`flex flex-col items-center py-1.5 px-3 transition-colors ${
            activeTab === "descargas" ? "text-rose-400" : "text-neutral-500"
          }`}
        >
          <Download className="h-5 w-5 mb-0.5" />
          <span>Descargas</span>
        </button>
        {((currentUser?.isAdmin && currentUser?.email?.toLowerCase().trim() === "baezcabrera.j.r@gmail.com") ||
          (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"))) && (
          <button
            onClick={() => setActiveTab("admin")}
            className={`flex flex-col items-center py-1.5 px-3 transition-colors ${
              activeTab === "admin" ? "text-rose-400" : "text-neutral-500"
            }`}
          >
            <Compass className="h-5 w-5 mb-0.5" />
            <span>Admin</span>
          </button>
        )}
      </div>
    </header>
  );
}
