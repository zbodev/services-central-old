/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Mozilla code.
 *
 * The Initial Developer of the Original Code is the Mozilla Corporation.
 * Portions created by the Initial Developer are Copyright (C) 2007
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Chris Double <chris.double@double.co.nz>
 *  Chris Pearce <chris@pearce.org.nz>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */
#include "nsError.h"
#include "nsBuiltinDecoderStateMachine.h"
#include "nsBuiltinDecoder.h"
#include "nsMediaStream.h"
#include "nsWebMReader.h"
#include "VideoUtils.h"
#include "nsTimeRanges.h"
#include "mozilla/Preferences.h"

using namespace mozilla;
using namespace mozilla::layers;

// Un-comment to enable logging of seek bisections.
//#define SEEK_LOGGING

#ifdef PR_LOGGING
extern PRLogModuleInfo* gBuiltinDecoderLog;
#define LOG(type, msg) PR_LOG(gBuiltinDecoderLog, type, msg)
#ifdef SEEK_LOGGING
#define SEEK_LOG(type, msg) PR_LOG(gBuiltinDecoderLog, type, msg)
#else
#define SEEK_LOG(type, msg)
#endif
#else
#define LOG(type, msg)
#define SEEK_LOG(type, msg)
#endif

static const unsigned NS_PER_USEC = 1000;
static const double NS_PER_S = 1e9;

// If a seek request is within SEEK_DECODE_MARGIN microseconds of the
// current time, decode ahead from the current frame rather than performing
// a full seek.
static const int SEEK_DECODE_MARGIN = 250000;

NS_SPECIALIZE_TEMPLATE
class nsAutoRefTraits<NesteggPacketHolder> : public nsPointerRefTraits<NesteggPacketHolder>
{
public:
  static void Release(NesteggPacketHolder* aHolder) { delete aHolder; }
};

// Functions for reading and seeking using nsMediaStream required for
// nestegg_io. The 'user data' passed to these functions is the
// decoder from which the media stream is obtained.
static int webm_read(void *aBuffer, size_t aLength, void *aUserData)
{
  NS_ASSERTION(aUserData, "aUserData must point to a valid nsBuiltinDecoder");
  nsBuiltinDecoder* decoder = reinterpret_cast<nsBuiltinDecoder*>(aUserData);
  nsMediaStream* stream = decoder->GetCurrentStream();
  NS_ASSERTION(stream, "Decoder has no media stream");

  nsresult rv = NS_OK;
  PRBool eof = PR_FALSE;

  char *p = static_cast<char *>(aBuffer);
  while (NS_SUCCEEDED(rv) && aLength > 0) {
    PRUint32 bytes = 0;
    rv = stream->Read(p, aLength, &bytes);
    if (bytes == 0) {
      eof = PR_TRUE;
      break;
    }
    decoder->NotifyBytesConsumed(bytes);
    aLength -= bytes;
    p += bytes;
  }

  return NS_FAILED(rv) ? -1 : eof ? 0 : 1;
}

static int webm_seek(int64_t aOffset, int aWhence, void *aUserData)
{
  NS_ASSERTION(aUserData, "aUserData must point to a valid nsBuiltinDecoder");
  nsBuiltinDecoder* decoder = reinterpret_cast<nsBuiltinDecoder*>(aUserData);
  nsMediaStream* stream = decoder->GetCurrentStream();
  NS_ASSERTION(stream, "Decoder has no media stream");
  nsresult rv = stream->Seek(aWhence, aOffset);
  return NS_SUCCEEDED(rv) ? 0 : -1;
}

static int64_t webm_tell(void *aUserData)
{
  NS_ASSERTION(aUserData, "aUserData must point to a valid nsBuiltinDecoder");
  nsBuiltinDecoder* decoder = reinterpret_cast<nsBuiltinDecoder*>(aUserData);
  nsMediaStream* stream = decoder->GetCurrentStream();
  NS_ASSERTION(stream, "Decoder has no media stream");
  return stream->Tell();
}

nsWebMReader::nsWebMReader(nsBuiltinDecoder* aDecoder)
  : nsBuiltinDecoderReader(aDecoder),
  mContext(nsnull),
  mPacketCount(0),
  mChannels(0),
  mVideoTrack(0),
  mAudioTrack(0),
  mAudioStartUsec(-1),
  mAudioSamples(0),
  mHasVideo(PR_FALSE),
  mHasAudio(PR_FALSE)
{
  MOZ_COUNT_CTOR(nsWebMReader);
}

nsWebMReader::~nsWebMReader()
{
  Cleanup();

  mVideoPackets.Reset();
  mAudioPackets.Reset();

  vpx_codec_destroy(&mVP8);

  vorbis_block_clear(&mVorbisBlock);
  vorbis_dsp_clear(&mVorbisDsp);
  vorbis_info_clear(&mVorbisInfo);
  vorbis_comment_clear(&mVorbisComment);

  MOZ_COUNT_DTOR(nsWebMReader);
}

nsresult nsWebMReader::Init(nsBuiltinDecoderReader* aCloneDonor)
{
  if (vpx_codec_dec_init(&mVP8, &vpx_codec_vp8_dx_algo, NULL, 0)) {
    return NS_ERROR_FAILURE;
  }

  vorbis_info_init(&mVorbisInfo);
  vorbis_comment_init(&mVorbisComment);
  memset(&mVorbisDsp, 0, sizeof(vorbis_dsp_state));
  memset(&mVorbisBlock, 0, sizeof(vorbis_block));

  if (aCloneDonor) {
    mBufferedState = static_cast<nsWebMReader*>(aCloneDonor)->mBufferedState;
  } else {
    mBufferedState = new nsWebMBufferedState;
  }

  return NS_OK;
}

nsresult nsWebMReader::ResetDecode()
{
  mAudioSamples = 0;
  mAudioStartUsec = -1;
  nsresult res = NS_OK;
  if (NS_FAILED(nsBuiltinDecoderReader::ResetDecode())) {
    res = NS_ERROR_FAILURE;
  }

  // Ignore failed results from vorbis_synthesis_restart. They
  // aren't fatal and it fails when ResetDecode is called at a
  // time when no vorbis data has been read.
  vorbis_synthesis_restart(&mVorbisDsp);

  mVideoPackets.Reset();
  mAudioPackets.Reset();

  return res;
}

void nsWebMReader::Cleanup()
{
  if (mContext) {
    nestegg_destroy(mContext);
    mContext = nsnull;
  }
}

nsresult nsWebMReader::ReadMetadata(nsVideoInfo* aInfo)
{
  NS_ASSERTION(mDecoder->OnDecodeThread(), "Should be on decode thread.");

  nestegg_io io;
  io.read = webm_read;
  io.seek = webm_seek;
  io.tell = webm_tell;
  io.userdata = static_cast<nsBuiltinDecoder*>(mDecoder);
  int r = nestegg_init(&mContext, io, NULL);
  if (r == -1) {
    return NS_ERROR_FAILURE;
  }

  uint64_t duration = 0;
  r = nestegg_duration(mContext, &duration);
  if (r == 0) {
    ReentrantMonitorAutoEnter mon(mDecoder->GetReentrantMonitor());
    mDecoder->GetStateMachine()->SetDuration(duration / NS_PER_USEC);
  }

  unsigned int ntracks = 0;
  r = nestegg_track_count(mContext, &ntracks);
  if (r == -1) {
    Cleanup();
    return NS_ERROR_FAILURE;
  }

  mInfo.mHasAudio = PR_FALSE;
  mInfo.mHasVideo = PR_FALSE;
  for (PRUint32 track = 0; track < ntracks; ++track) {
    int id = nestegg_track_codec_id(mContext, track);
    if (id == -1) {
      Cleanup();
      return NS_ERROR_FAILURE;
    }
    int type = nestegg_track_type(mContext, track);
    if (!mHasVideo && type == NESTEGG_TRACK_VIDEO) {
      nestegg_video_params params;
      r = nestegg_track_video_params(mContext, track, &params);
      if (r == -1) {
        Cleanup();
        return NS_ERROR_FAILURE;
      }

      // Picture region, taking into account cropping, before scaling
      // to the display size.
      nsIntRect pictureRect(params.crop_left,
                            params.crop_top,
                            params.width - (params.crop_right + params.crop_left),
                            params.height - (params.crop_bottom + params.crop_top));

      // If the cropping data appears invalid then use the frame data
      if (pictureRect.width <= 0 ||
          pictureRect.height <= 0 ||
          pictureRect.x < 0 ||
          pictureRect.y < 0)
      {
        pictureRect.x = 0;
        pictureRect.y = 0;
        pictureRect.width = params.width;
        pictureRect.height = params.height;
      }

      // Validate the container-reported frame and pictureRect sizes. This ensures
      // that our video frame creation code doesn't overflow.
      nsIntSize displaySize(params.display_width, params.display_height);
      nsIntSize frameSize(params.width, params.height);
      if (!nsVideoInfo::ValidateVideoRegion(frameSize, pictureRect, displaySize)) {
        // Video track's frame sizes will overflow. Ignore the video track.
        continue;
      }

      mVideoTrack = track;
      mHasVideo = PR_TRUE;
      mInfo.mHasVideo = PR_TRUE;

      mInfo.mDisplay = displaySize;
      mPicture = pictureRect;
      mInitialFrame = frameSize;

      switch (params.stereo_mode) {
      case NESTEGG_VIDEO_MONO:
        mInfo.mStereoMode = STEREO_MODE_MONO;
        break;
      case NESTEGG_VIDEO_STEREO_LEFT_RIGHT:
        mInfo.mStereoMode = STEREO_MODE_LEFT_RIGHT;
        break;
      case NESTEGG_VIDEO_STEREO_BOTTOM_TOP:
        mInfo.mStereoMode = STEREO_MODE_BOTTOM_TOP;
        break;
      case NESTEGG_VIDEO_STEREO_TOP_BOTTOM:
        mInfo.mStereoMode = STEREO_MODE_TOP_BOTTOM;
        break;
      case NESTEGG_VIDEO_STEREO_RIGHT_LEFT:
        mInfo.mStereoMode = STEREO_MODE_RIGHT_LEFT;
        break;
      }

      PRInt32 forceStereoMode;
      if (NS_SUCCEEDED(Preferences::GetInt("media.webm.force_stereo_mode",
                                           &forceStereoMode))) {
        switch (forceStereoMode) {
        case 1:
          mInfo.mStereoMode = STEREO_MODE_LEFT_RIGHT;
          break;
        case 2:
          mInfo.mStereoMode = STEREO_MODE_RIGHT_LEFT;
          break;
        case 3:
          mInfo.mStereoMode = STEREO_MODE_TOP_BOTTOM;
          break;
        case 4:
          mInfo.mStereoMode = STEREO_MODE_BOTTOM_TOP;
          break;
        default:
          mInfo.mStereoMode = STEREO_MODE_MONO;
        }
      }
    }
    else if (!mHasAudio && type == NESTEGG_TRACK_AUDIO) {
      nestegg_audio_params params;
      r = nestegg_track_audio_params(mContext, track, &params);
      if (r == -1) {
        Cleanup();
        return NS_ERROR_FAILURE;
      }

      mAudioTrack = track;
      mHasAudio = PR_TRUE;
      mInfo.mHasAudio = PR_TRUE;

      // Get the Vorbis header data
      unsigned int nheaders = 0;
      r = nestegg_track_codec_data_count(mContext, track, &nheaders);
      if (r == -1 || nheaders != 3) {
        Cleanup();
        return NS_ERROR_FAILURE;
      }

      for (PRUint32 header = 0; header < nheaders; ++header) {
        unsigned char* data = 0;
        size_t length = 0;

        r = nestegg_track_codec_data(mContext, track, header, &data, &length);
        if (r == -1) {
          Cleanup();
          return NS_ERROR_FAILURE;
        }

        ogg_packet opacket = InitOggPacket(data, length, header == 0, PR_FALSE, 0);

        r = vorbis_synthesis_headerin(&mVorbisInfo,
                                      &mVorbisComment,
                                      &opacket);
        if (r != 0) {
          Cleanup();
          return NS_ERROR_FAILURE;
        }
      }

      r = vorbis_synthesis_init(&mVorbisDsp, &mVorbisInfo);
      if (r != 0) {
        Cleanup();
        return NS_ERROR_FAILURE;
      }

      r = vorbis_block_init(&mVorbisDsp, &mVorbisBlock);
      if (r != 0) {
        Cleanup();
        return NS_ERROR_FAILURE;
      }

      mInfo.mAudioRate = mVorbisDsp.vi->rate;
      mInfo.mAudioChannels = mVorbisDsp.vi->channels;
      mChannels = mInfo.mAudioChannels;
    }
  }

  *aInfo = mInfo;

  return NS_OK;
}

ogg_packet nsWebMReader::InitOggPacket(unsigned char* aData,
                                       size_t aLength,
                                       PRBool aBOS,
                                       PRBool aEOS,
                                       PRInt64 aGranulepos)
{
  ogg_packet packet;
  packet.packet = aData;
  packet.bytes = aLength;
  packet.b_o_s = aBOS;
  packet.e_o_s = aEOS;
  packet.granulepos = aGranulepos;
  packet.packetno = mPacketCount++;
  return packet;
}
 
PRBool nsWebMReader::DecodeAudioPacket(nestegg_packet* aPacket, PRInt64 aOffset)
{
  NS_ASSERTION(mDecoder->OnDecodeThread(), "Should be on decode thread.");

  int r = 0;
  unsigned int count = 0;
  r = nestegg_packet_count(aPacket, &count);
  if (r == -1) {
    return PR_FALSE;
  }

  uint64_t tstamp = 0;
  r = nestegg_packet_tstamp(aPacket, &tstamp);
  if (r == -1) {
    return PR_FALSE;
  }

  const PRUint32 rate = mVorbisDsp.vi->rate;
  PRUint64 tstamp_usecs = tstamp / NS_PER_USEC;
  if (mAudioStartUsec == -1) {
    // This is the first audio chunk. Assume the start time of our decode
    // is the start of this chunk.
    mAudioStartUsec = tstamp_usecs;
  }
  // If there's a gap between the start of this sound chunk and the end of
  // the previous sound chunk, we need to increment the packet count so that
  // the vorbis decode doesn't use data from before the gap to help decode
  // from after the gap.
  PRInt64 tstamp_samples = 0;
  if (!UsecsToSamples(tstamp_usecs, rate, tstamp_samples)) {
    NS_WARNING("Int overflow converting WebM timestamp to samples");
    return PR_FALSE;
  }
  PRInt64 decoded_samples = 0;
  if (!UsecsToSamples(mAudioStartUsec, rate, decoded_samples)) {
    NS_WARNING("Int overflow converting WebM start time to samples");
    return PR_FALSE;
  }
  if (!AddOverflow(decoded_samples, mAudioSamples, decoded_samples)) {
    NS_WARNING("Int overflow adding decoded_samples");
    return PR_FALSE;
  }
  if (tstamp_samples > decoded_samples) {
#ifdef DEBUG
    PRInt64 usecs = 0;
    LOG(PR_LOG_DEBUG, ("WebMReader detected gap of %lld, %lld samples, in audio stream\n",
      SamplesToUsecs(tstamp_samples - decoded_samples, rate, usecs) ? usecs: -1,
      tstamp_samples - decoded_samples));
#endif
    mPacketCount++;
    mAudioStartUsec = tstamp_usecs;
    mAudioSamples = 0;
  }

  PRInt32 total_samples = 0;
  for (PRUint32 i = 0; i < count; ++i) {
    unsigned char* data;
    size_t length;
    r = nestegg_packet_data(aPacket, i, &data, &length);
    if (r == -1) {
      return PR_FALSE;
    }

    ogg_packet opacket = InitOggPacket(data, length, PR_FALSE, PR_FALSE, -1);

    if (vorbis_synthesis(&mVorbisBlock, &opacket) != 0) {
      return PR_FALSE;
    }

    if (vorbis_synthesis_blockin(&mVorbisDsp,
                                 &mVorbisBlock) != 0) {
      return PR_FALSE;
    }

    VorbisPCMValue** pcm = 0;
    PRInt32 samples = 0;
    while ((samples = vorbis_synthesis_pcmout(&mVorbisDsp, &pcm)) > 0) {
      SoundDataValue* buffer = new SoundDataValue[samples * mChannels];
      for (PRUint32 j = 0; j < mChannels; ++j) {
        VorbisPCMValue* channel = pcm[j];
        for (PRUint32 i = 0; i < PRUint32(samples); ++i) {
          buffer[i*mChannels + j] = MOZ_CONVERT_VORBIS_SAMPLE(channel[i]);
        }
      }

      PRInt64 duration = 0;
      if (!SamplesToUsecs(samples, rate, duration)) {
        NS_WARNING("Int overflow converting WebM audio duration");
        return PR_FALSE;
      }
      PRInt64 total_duration = 0;
      if (!SamplesToUsecs(total_samples, rate, total_duration)) {
        NS_WARNING("Int overflow converting WebM audio total_duration");
        return PR_FALSE;
      }
      
      PRInt64 time = tstamp_usecs + total_duration;
      total_samples += samples;
      SoundData* s = new SoundData(aOffset,
                                   time,
                                   duration,
                                   samples,
                                   buffer,
                                   mChannels);
      mAudioQueue.Push(s);
      mAudioSamples += samples;
      if (vorbis_synthesis_read(&mVorbisDsp, samples) != 0) {
        return PR_FALSE;
      }
    }
  }

  return PR_TRUE;
}

nsReturnRef<NesteggPacketHolder> nsWebMReader::NextPacket(TrackType aTrackType)
{
  // The packet queue that packets will be pushed on if they
  // are not the type we are interested in.
  PacketQueue& otherPackets = 
    aTrackType == VIDEO ? mAudioPackets : mVideoPackets;

  // The packet queue for the type that we are interested in.
  PacketQueue &packets =
    aTrackType == VIDEO ? mVideoPackets : mAudioPackets;

  // Flag to indicate that we do need to playback these types of
  // packets.
  PRPackedBool hasType = aTrackType == VIDEO ? mHasVideo : mHasAudio;

  // Flag to indicate that we do need to playback the other type
  // of track.
  PRPackedBool hasOtherType = aTrackType == VIDEO ? mHasAudio : mHasVideo;

  // Track we are interested in
  PRUint32 ourTrack = aTrackType == VIDEO ? mVideoTrack : mAudioTrack;

  // Value of other track
  PRUint32 otherTrack = aTrackType == VIDEO ? mAudioTrack : mVideoTrack;

  nsAutoRef<NesteggPacketHolder> holder;

  if (packets.GetSize() > 0) {
    holder.own(packets.PopFront());
  } else {
    // Keep reading packets until we find a packet
    // for the track we want.
    do {
      nestegg_packet* packet;
      int r = nestegg_read_packet(mContext, &packet);
      if (r <= 0) {
        return nsReturnRef<NesteggPacketHolder>();
      }
      PRInt64 offset = mDecoder->GetCurrentStream()->Tell();
      holder.own(new NesteggPacketHolder(packet, offset));

      unsigned int track = 0;
      r = nestegg_packet_track(packet, &track);
      if (r == -1) {
        return nsReturnRef<NesteggPacketHolder>();
      }

      if (hasOtherType && otherTrack == track) {
        // Save the packet for when we want these packets
        otherPackets.Push(holder.disown());
        continue;
      }

      // The packet is for the track we want to play
      if (hasType && ourTrack == track) {
        break;
      }
    } while (PR_TRUE);
  }

  return holder.out();
}

PRBool nsWebMReader::DecodeAudioData()
{
  NS_ASSERTION(mDecoder->OnDecodeThread(), "Should be on decode thread.");

  nsAutoRef<NesteggPacketHolder> holder(NextPacket(AUDIO));
  if (!holder) {
    mAudioQueue.Finish();
    return PR_FALSE;
  }

  return DecodeAudioPacket(holder->mPacket, holder->mOffset);
}

PRBool nsWebMReader::DecodeVideoFrame(PRBool &aKeyframeSkip,
                                      PRInt64 aTimeThreshold)
{
  NS_ASSERTION(mDecoder->OnDecodeThread(), "Should be on decode thread.");

  // Record number of frames decoded and parsed. Automatically update the
  // stats counters using the AutoNotifyDecoded stack-based class.
  PRUint32 parsed = 0, decoded = 0;
  nsMediaDecoder::AutoNotifyDecoded autoNotify(mDecoder, parsed, decoded);

  nsAutoRef<NesteggPacketHolder> holder(NextPacket(VIDEO));
  if (!holder) {
    mVideoQueue.Finish();
    return PR_FALSE;
  }

  nestegg_packet* packet = holder->mPacket;
  unsigned int track = 0;
  int r = nestegg_packet_track(packet, &track);
  if (r == -1) {
    return PR_FALSE;
  }

  unsigned int count = 0;
  r = nestegg_packet_count(packet, &count);
  if (r == -1) {
    return PR_FALSE;
  }

  uint64_t tstamp = 0;
  r = nestegg_packet_tstamp(packet, &tstamp);
  if (r == -1) {
    return PR_FALSE;
  }

  // The end time of this frame is the start time of the next frame.  Fetch
  // the timestamp of the next packet for this track.  If we've reached the
  // end of the stream, use the file's duration as the end time of this
  // video frame.
  uint64_t next_tstamp = 0;
  {
    nsAutoRef<NesteggPacketHolder> next_holder(NextPacket(VIDEO));
    if (next_holder) {
      r = nestegg_packet_tstamp(next_holder->mPacket, &next_tstamp);
      if (r == -1) {
        return PR_FALSE;
      }
      mVideoPackets.PushFront(next_holder.disown());
    } else {
      ReentrantMonitorAutoEnter decoderMon(mDecoder->GetReentrantMonitor());
      nsBuiltinDecoderStateMachine* s =
        static_cast<nsBuiltinDecoderStateMachine*>(mDecoder->GetStateMachine());
      PRInt64 endTime = s->GetEndMediaTime();
      if (endTime == -1) {
        return PR_FALSE;
      }
      next_tstamp = endTime * NS_PER_USEC;
    }
  }

  PRInt64 tstamp_usecs = tstamp / NS_PER_USEC;
  for (PRUint32 i = 0; i < count; ++i) {
    unsigned char* data;
    size_t length;
    r = nestegg_packet_data(packet, i, &data, &length);
    if (r == -1) {
      return PR_FALSE;
    }

    vpx_codec_stream_info_t si;
    memset(&si, 0, sizeof(si));
    si.sz = sizeof(si);
    vpx_codec_peek_stream_info(&vpx_codec_vp8_dx_algo, data, length, &si);
    if (aKeyframeSkip && (!si.is_kf || tstamp_usecs < aTimeThreshold)) {
      // Skipping to next keyframe...
      parsed++; // Assume 1 frame per chunk.
      continue;
    }

    if (aKeyframeSkip && si.is_kf) {
      aKeyframeSkip = PR_FALSE;
    }

    if (vpx_codec_decode(&mVP8, data, length, NULL, 0)) {
      return PR_FALSE;
    }

    // If the timestamp of the video frame is less than
    // the time threshold required then it is not added
    // to the video queue and won't be displayed.
    if (tstamp_usecs < aTimeThreshold) {
      parsed++; // Assume 1 frame per chunk.
      continue;
    }

    vpx_codec_iter_t  iter = NULL;
    vpx_image_t      *img;

    while ((img = vpx_codec_get_frame(&mVP8, &iter))) {
      NS_ASSERTION(img->fmt == IMG_FMT_I420, "WebM image format is not I420");

      // Chroma shifts are rounded down as per the decoding examples in the VP8 SDK
      VideoData::YCbCrBuffer b;
      b.mPlanes[0].mData = img->planes[0];
      b.mPlanes[0].mStride = img->stride[0];
      b.mPlanes[0].mHeight = img->d_h;
      b.mPlanes[0].mWidth = img->d_w;

      b.mPlanes[1].mData = img->planes[1];
      b.mPlanes[1].mStride = img->stride[1];
      b.mPlanes[1].mHeight = img->d_h >> img->y_chroma_shift;
      b.mPlanes[1].mWidth = img->d_w >> img->x_chroma_shift;
 
      b.mPlanes[2].mData = img->planes[2];
      b.mPlanes[2].mStride = img->stride[2];
      b.mPlanes[2].mHeight = img->d_h >> img->y_chroma_shift;
      b.mPlanes[2].mWidth = img->d_w >> img->x_chroma_shift;
  
      nsIntRect picture = mPicture;
      if (img->d_w != mInitialFrame.width || img->d_h != mInitialFrame.height) {
        // Frame size is different from what the container reports. This is legal
        // in WebM, and we will preserve the ratio of the crop rectangle as it
        // was reported relative to the picture size reported by the container.
        picture.x = (mPicture.x * img->d_w) / mInitialFrame.width;
        picture.y = (mPicture.y * img->d_h) / mInitialFrame.height;
        picture.width = (img->d_w * mPicture.width) / mInitialFrame.width;
        picture.height = (img->d_h * mPicture.height) / mInitialFrame.height;
      }

      VideoData *v = VideoData::Create(mInfo,
                                       mDecoder->GetImageContainer(),
                                       holder->mOffset,
                                       tstamp_usecs,
                                       next_tstamp / NS_PER_USEC,
                                       b,
                                       si.is_kf,
                                       -1,
                                       picture);
      if (!v) {
        return PR_FALSE;
      }
      parsed++;
      decoded++;
      NS_ASSERTION(decoded <= parsed,
        "Expect only 1 frame per chunk per packet in WebM...");
      mVideoQueue.Push(v);
    }
  }

  return PR_TRUE;
}

nsresult nsWebMReader::Seek(PRInt64 aTarget, PRInt64 aStartTime, PRInt64 aEndTime,
                            PRInt64 aCurrentTime)
{
  NS_ASSERTION(mDecoder->OnDecodeThread(), "Should be on decode thread.");

  LOG(PR_LOG_DEBUG, ("%p About to seek to %lldms", mDecoder, aTarget));
  if (NS_FAILED(ResetDecode())) {
    return NS_ERROR_FAILURE;
  }
  PRUint32 trackToSeek = mHasVideo ? mVideoTrack : mAudioTrack;
  int r = nestegg_track_seek(mContext, trackToSeek, aTarget * NS_PER_USEC);
  if (r != 0) {
    return NS_ERROR_FAILURE;
  }
  return DecodeToTarget(aTarget);
}

nsresult nsWebMReader::GetBuffered(nsTimeRanges* aBuffered, PRInt64 aStartTime)
{
  nsMediaStream* stream = mDecoder->GetCurrentStream();

  uint64_t timecodeScale;
  if (!mContext || nestegg_tstamp_scale(mContext, &timecodeScale) == -1) {
    return NS_OK;
  }

  // Special case completely cached files.  This also handles local files.
  if (stream->IsDataCachedToEndOfStream(0)) {
    uint64_t duration = 0;
    if (nestegg_duration(mContext, &duration) == 0) {
      aBuffered->Add(0, duration / NS_PER_S);
    }
  } else {
    nsMediaStream* stream = mDecoder->GetCurrentStream();
    nsTArray<nsByteRange> ranges;
    nsresult res = stream->GetCachedRanges(ranges);
    NS_ENSURE_SUCCESS(res, res);

    PRInt64 startTimeOffsetNS = aStartTime * NS_PER_USEC;
    for (PRUint32 index = 0; index < ranges.Length(); index++) {
      mBufferedState->CalculateBufferedForRange(aBuffered,
                                                ranges[index].mStart,
                                                ranges[index].mEnd,
                                                timecodeScale,
                                                startTimeOffsetNS);
    }
  }

  return NS_OK;
}

void nsWebMReader::NotifyDataArrived(const char* aBuffer, PRUint32 aLength, PRUint32 aOffset)
{
  mBufferedState->NotifyDataArrived(aBuffer, aLength, aOffset);
}
