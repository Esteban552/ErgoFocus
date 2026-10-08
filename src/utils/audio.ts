import { AudioPlayer, createAudioPlayer, setAudioModeAsync } from 'expo-audio';

type ChimeName = 'gentle' | 'correction' | 'success';

const SOURCES: Record<ChimeName, number> = {
  gentle: require('../../assets/sounds/gentle-chime.wav'),
  correction: require('../../assets/sounds/correction-pulse.wav'),
  success: require('../../assets/sounds/success-chime.wav'),
};

class SoundService {
  private soundEnabled: boolean = true;
  private players: Partial<Record<ChimeName, AudioPlayer>> = {};
  private audioModeReady = false;

  private ensureAudioMode() {
    if (this.audioModeReady) return;
    this.audioModeReady = true;
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {
      this.audioModeReady = false;
    });
  }

  private play(name: ChimeName) {
    if (!this.soundEnabled) return;
    try {
      this.ensureAudioMode();
      let player = this.players[name];
      if (!player) {
        player = createAudioPlayer(SOURCES[name]);
        this.players[name] = player;
      }
      player.seekTo(0);
      player.play();
    } catch {
      // Audio might be unavailable on web or before user gesture
    }
  }

  public setSoundEnabled(enabled: boolean) {
    this.soundEnabled = enabled;
  }

  public isEnabled() {
    return this.soundEnabled;
  }

  // Calm meditative chime (528Hz Solfeggio / harmonious chime)
  public playGentleChime() {
    this.play('gentle');
  }

  // Subtle posture correction alert (dual low pulse, non-jarring)
  public playCorrectionPulse() {
    this.play('correction');
  }

  // Success complete chime
  public playSuccessChime() {
    this.play('success');
  }
}

export const soundService = new SoundService();
