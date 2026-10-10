import { registerWebModule, NativeModule } from 'expo';

// ErgoFocusBackgroundMonitoringModule is not available on the web platform.
class ErgoFocusBackgroundMonitoringModule extends NativeModule<{}> {}

export default registerWebModule(ErgoFocusBackgroundMonitoringModule, 'ErgoFocusBackgroundMonitoringModule');
