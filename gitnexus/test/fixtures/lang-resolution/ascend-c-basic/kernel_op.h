#ifndef KERNEL_OP_H
#define KERNEL_OP_H

#include "kernel_operator.h"

class KernelAdd {
public:
    __aicore__ inline void Init(__gm__ uint8_t* src0, __gm__ uint8_t* src1, __gm__ uint8_t* dst, uint32_t totalLength) {
        this->blockLength = totalLength / GetBlockNum();
        this->tileNum = 8;
        this->tileLength = this->blockLength / this->tileNum;

        src0Global.SetGlobalBuffer((__gm__ half*)src0 + this->blockLength * GetBlockIdx(), this->blockLength);
        src1Global.SetGlobalBuffer((__gm__ half*)src1 + this->blockLength * GetBlockIdx(), this->blockLength);
        dstGlobal.SetGlobalBuffer((__gm__ half*)dst + this->blockLength * GetBlockIdx(), this->blockLength);

        pipe.InitBuffer(inQueueSrc0, this->tileNum, this->tileLength * sizeof(half));
        pipe.InitBuffer(inQueueSrc1, this->tileNum, this->tileLength * sizeof(half));
        pipe.InitBuffer(outQueueDst, this->tileNum, this->tileLength * sizeof(half));
    }

    __aicore__ inline void Process() {
        for (int32_t i = 0; i < this->tileNum; i++) {
            CopyIn(i);
            Compute(i);
            CopyOut(i);
        }
    }

private:
    __aicore__ inline void CopyIn(int32_t progress) {
        LocalTensor<half> src0Local = inQueueSrc0.AllocTensor<half>();
        LocalTensor<half> src1Local = inQueueSrc1.AllocTensor<half>();
        DataCopy(src0Local, src0Global[progress * this->tileLength], this->tileLength);
        DataCopy(src1Local, src1Global[progress * this->tileLength], this->tileLength);
        inQueueSrc0.EnQue(src0Local);
        inQueueSrc1.EnQue(src1Local);
    }

    __aicore__ inline void Compute(int32_t progress) {
        LocalTensor<half> src0Local = inQueueSrc0.DeQue<half>();
        LocalTensor<half> src1Local = inQueueSrc1.DeQue<half>();
        LocalTensor<half> dstLocal = outQueueDst.AllocTensor<half>();
        Add(dstLocal, src0Local, src1Local, this->tileLength);
        outQueueDst.EnQue(dstLocal);
        inQueueSrc0.FreeTensor(src0Local);
        inQueueSrc1.FreeTensor(src1Local);
    }

    __aicore__ inline void CopyOut(int32_t progress) {
        LocalTensor<half> dstLocal = outQueueDst.DeQue<half>();
        DataCopy(dstGlobal[progress * this->tileLength], dstLocal, this->tileLength);
        outQueueDst.FreeTensor(dstLocal);
    }

    TPipe pipe;
    TQue<QuePosition::VECIN, 1> inQueueSrc0, inQueueSrc1;
    TQue<QuePosition::VECOUT, 1> outQueueDst;
    GlobalTensor<half> src0Global, src1Global, dstGlobal;
    uint32_t blockLength;
    uint32_t tileNum;
    uint32_t tileLength;
};

#endif
