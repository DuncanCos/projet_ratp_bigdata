import { useEffect, useRef, useState } from "react";
import { api, TrafficInfo, TrainsResponse } from "./api";

/** Horloge partagée pour animer les trains entre deux rafraîchissements. */
export function useNow(intervalMs = 500) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useTrains(lineIds: string[], liveIds: string[], refreshSec: number, reloadKey: number) {
  const [data, setData] = useState<TrainsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = `${lineIds.join(",")}|${liveIds.join(",")}`;
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const mine = ++seq.current;
      setLoading(true);
      try {
        const r = await api.trains(lineIds, liveIds);
        if (alive && mine === seq.current) {
          setData(r);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, refreshSec * 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshSec, reloadKey]);

  return { data, error, loading };
}

/** Info trafic, rafraîchie toutes les 2 minutes (le cache Rust fait de même). */
export function useTraffic(reloadKey: number) {
  const [info, setInfo] = useState<TrafficInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .traffic()
        .then((i) => alive && (setInfo(i), setError(null)))
        .catch((e) => alive && setError(String(e)));
    load();
    const id = setInterval(load, 120_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [reloadKey]);
  return { info, error };
}

/** Vrai sous 768 px de large : interface téléphone. */
export function useIsMobile() {
  const query = "(max-width: 767px)";
  const [mobile, setMobile] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}
