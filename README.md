# ElderCare Sentinel

A webcam-based safety and medicine-reminder assistant for elderly people living alone. It watches for falls and hand signals in real time, reminds the person to take their medicine, and contacts a caregiver by **email, phone call and SMS** if the person does not respond to an alert.

All video processing runs **in the browser**. The camera feed is never uploaded or stored.

## Features

- **Fall detection:** tracks body posture and shows Standing, Sitting, Lying down or FALLEN. A fall is flagged when the person drops suddenly and stays horizontal, or lies still for 8 seconds.
- **Gesture control:** a thumbs up cancels an alert or confirms a medicine. An open palm held for about 2 seconds is a help signal.
- **10-second emergency countdown:** on any danger an alarm sounds and a countdown starts. A thumbs up (or the "I'm OK" button) cancels it. If it reaches zero, the caregiver is contacted.
- **Medicine scheduler:** add a medicine with name, dosage and time, repeating **every day** or on **one chosen date**. Schedules are saved in the browser.
- **Audio reminders:** at the scheduled time your own audio file plays on a loop and stops only when the person shows a thumbs up.
- **Caregiver alerts:** email through SMTP (for example Gmail), and phone call plus SMS through Twilio. If the server cannot be reached, the app offers Call, Text and Email buttons as a manual backup.
- **Event log:** a timestamped record of detections, reminders and each alert channel's result.

## How it works

| Part | Technology |
|---|---|
| Posture / fall detection | [MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker) (lite model) with rules on body angle, shape, hip drop speed and time spent horizontal |
| Gesture recognition | [MediaPipe Gesture Recognizer](https://ai.google.dev/edge/mediapipe/solutions/vision/gesture_recognizer) (`Thumb_Up`, `Open_Palm`) |
| Frontend | React, Bootstrap, lucide-react |
| Alert server | Node.js, Express |
| Email | Nodemailer (SMTP) |
| Phone call and SMS | Twilio |

The models are loaded from Google's public hosting and run in the browser using WebAssembly (GPU first, CPU as fallback). Detection runs about 10 times per second.

## Project structure

```
eldercare-sentinel/
├── public/
│   └── medicine.mpeg        # your reminder audio file
├── src/
│   └── App.jsx              # frontend: detection, scheduler, UI
└── backend/
    ├── server.js            # alert server (email, call, SMS)
    ├── package.json         # needs "type": "module"
    └── .env                 # your secrets (never commit this)
```

## Getting started

### 1. Frontend

```bash
npm install
npm install @mediapipe/tasks-vision lucide-react bootstrap
npm start          # or: npm run dev
```

Put your reminder sound in the `public` folder. If it is not named `medicine.mpeg`, change `MED_AUDIO` at the top of `App.jsx`.

### 2. Backend

```bash
cd backend
npm init -y
npm install express cors nodemailer twilio dotenv
```

Add `"type": "module"` to `backend/package.json`, then create `backend/.env`:

```env
PORT=5000

# Email (Gmail needs an app password, not your normal password)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@gmail.com
SMTP_PASS=your-16-character-app-password
ALERT_EMAIL=caregiver@example.com

# Phone call + SMS (optional)
TWILIO_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_TOKEN=your_auth_token
TWILIO_FROM=+1xxxxxxxxxx        # your Twilio number (the caller)
ALERT_PHONE=+91xxxxxxxxxx       # caregiver number (used if the form is empty)
```

Start the server:

```bash
node server.js
```

### 3. Test everything

- Email: open `http://localhost:5000/api/test-email`
- Call: open `http://localhost:5000/api/test-call`
- Full flow: in the app click **Start monitoring**, then **Test the 10-second alert** and do not show a thumbs up.

## Using the app

1. Click **Start monitoring** and allow camera access. This click is also what lets the browser play sound.
2. Enter the caregiver's name, email and phone (with country code, for example `+91xxxxxxxxxx`).
3. Add medicines in the schedule form.
4. Keep the tab open and the screen awake. Stand or sit where your upper body is visible to the camera.

## Setting up Twilio

- Trial accounts can only call **verified numbers**. Add the caregiver's number under Phone Numbers, Manage, Verified Caller IDs.
- To call India, enable it under Voice, Settings, **Geo Permissions**.
- Trial calls begin with a Twilio trial message and may need a key press before your alert is spoken.
- SMS to Indian numbers often does not arrive without sender registration, so rely on the call and email.
- Failed calls show their error code in Twilio's Monitor, Logs, Calls.

## Limitations

- This is a hobby and learning project, **not a certified medical or safety device**. Do not rely on it as the only protection for someone at real risk.
- Falls are detected with rules on top of a pose model, not a trained fall model. Expect false alarms (for example resting on a sofa) and missed falls (for example out of camera view or in poor light).
- The camera must see the person's shoulders and hips. The browser tab must stay open.
- Medicine schedules and caregiver details are stored in the browser's local storage, so they are per device and per browser.
- The `/api/alert` endpoint has no login. Before putting the server on the internet, add authentication and rate limiting, or anyone who can reach it could trigger calls and emails.

## Security

- Never commit `.env`. Add it to `.gitignore`:
  ```
  .env
  node_modules/
  ```
- Use a Gmail app password and rotate it if it leaks.
- Keep your Twilio auth token private.

## Roadmap ideas

- Login and a private alert endpoint
- A trained fall-detection model
- Medicine history and missed-dose alerts to the caregiver
- Multiple caregivers and an escalation order
- Mobile-friendly installable app (PWA)

## License

Choose a license (for example MIT) and add a `LICENSE` file.

## Acknowledgements

[MediaPipe](https://ai.google.dev/edge/mediapipe) by Google, [Twilio](https://www.twilio.com), [Nodemailer](https://nodemailer.com).
