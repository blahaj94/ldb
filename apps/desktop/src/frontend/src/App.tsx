import { AuthBridge } from './auth/AuthBridge'
import PartyCapture from './capture/PartyCapture'

function App(): React.JSX.Element {
  return <AuthBridge api={window.auth} home={<PartyCapture />} />
}

export default App
